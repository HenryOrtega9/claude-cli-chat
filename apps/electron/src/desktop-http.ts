/* HTTP for the desktop shell, on node's stack instead of the renderer's.

   Obsidian's requestUrl runs in Electron's main process and is therefore
   exempt from CORS: shared code was written against a transport that just
   sends the request the caller described. A renderer `fetch` is not that —
   Chromium sees a cross-origin POST with Content-Type: application/json,
   fires an OPTIONS preflight first, and fails the whole call when the peer
   answers without CORS headers. The known casualty is StateEmitter, which
   POSTs JSON to the TC001 (an AWTRIX device on the LAN that has never heard
   of CORS) and races a 500ms timeout, so a preflight round-trip alone would
   sink it. node:http speaks straight to the socket, no preflight, no origin.

   The contract this must reproduce is obsidian.ts's httpRequest, not fetch's:
   resolve for any status unless throwOnError is on (the default) and the
   status is >= 400, and never let a non-JSON body turn into a rejection. */

import { request as httpSend, type IncomingMessage } from "node:http";
import { request as httpsSend } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import type { HttpRequestOptions, HttpResponse } from "../../../src/platform/types";

/* Chromium's own limit, and requestUrl inherits it. */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/* Backstop only. Callers own their real deadlines by racing the returned
   promise (StateEmitter races 500ms), and a request they abandoned still
   holds a socket open, so this exists purely to reap one that the peer never
   answers. Deliberately far above any caller's race so it can never be the
   thing that decides an outcome. */
const SOCKET_IDLE_TIMEOUT_MS = 60_000;

type RawResponse = { message: IncomingMessage; raw: Buffer };

export async function nodeHttpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  let url = new URL(options.url);
  let method = (options.method ?? "GET").toUpperCase();
  let body = options.body;
  const headers = buildRequestHeaders(options);

  for (let hop = 0; ; hop++) {
    const { message, raw } = await send(url, method, headers, body);
    const status = message.statusCode ?? 0;
    const location = message.headers.location;

    if (REDIRECT_STATUSES.has(status) && typeof location === "string") {
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (${MAX_REDIRECTS})`);
      /* Standard rewrite rules: 303 always downgrades to GET, 301/302
         downgrade anything that isn't already GET/HEAD (what every browser
         and Electron's net do in practice), 307/308 replay method and body
         verbatim. A downgraded request has no body, so its framing headers
         must go with it. */
      if (status === 303 || ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
        deleteHeader(headers, "content-length");
        deleteHeader(headers, "content-type");
      }
      url = new URL(location, url);
      continue;
    }

    const text = decodeBody(message, raw);
    if ((options.throwOnError ?? true) && status >= 400) {
      throw new Error(`Request failed, status ${status}`);
    }
    /* Same degradation as the Obsidian side, where resp.json is a getter that
       throws on a non-JSON body: callers can always trust `text`. */
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status, headers: collectHeaders(message), text, json };
  }
}

/* contentType wins over an explicit Content-Type in `headers`, matching how
   requestUrl treats its dedicated field. Content-Length is ours to add: node
   would otherwise fall back to chunked transfer-encoding, which embedded HTTP
   servers (the TC001's included) routinely fail to parse. */
function buildRequestHeaders(options: HttpRequestOptions): Record<string, string> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.contentType) {
    deleteHeader(headers, "content-type");
    headers["Content-Type"] = options.contentType;
  }
  if (options.body !== undefined && !hasHeader(headers, "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(options.body, "utf8"));
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
}

/* HttpResponse.headers is Record<string, string>, but node hands back
   string | string[] (set-cookie is always an array). Join rather than drop:
   no shared consumer reads a repeated header today, and losing values
   silently would be the worse failure. Keys arrive already lowercased. */
function collectHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/* We never advertise Accept-Encoding, so a conformant peer replies with
   identity bytes and this is a no-op. It exists for the peers that compress
   anyway, which Chromium (and therefore requestUrl) would have decoded
   transparently. Bodies on this path are small — API JSON and device acks —
   so the sync variants are fine. */
function decodeBody(message: IncomingMessage, raw: Buffer): string {
  const encoding = String(message.headers["content-encoding"] ?? "").toLowerCase();
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(raw).toString("utf8");
    if (encoding === "deflate") return inflateSync(raw).toString("utf8");
    if (encoding === "br") return brotliDecompressSync(raw).toString("utf8");
  } catch {
    /* Mislabeled or truncated body: hand back the raw bytes rather than
       failing a request the caller could still make sense of. */
  }
  return raw.toString("utf8");
}

function send(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error(`Unsupported protocol ${url.protocol}`));
      return;
    }
    const transport = url.protocol === "https:" ? httpsSend : httpSend;
    /* agent: false — one fresh connection per request, no keep-alive pool.
       Callers here are infrequent and the pool's failure mode is ugly: a
       socket parked against a device that power-cycled comes back as an
       ECONNRESET on the next push instead of a clean connect. */
    const req = transport(url, { method, headers, agent: false }, message => {
      const chunks: Buffer[] = [];
      message.on("data", (chunk: Buffer) => chunks.push(chunk));
      message.on("end", () => resolve({ message, raw: Buffer.concat(chunks) }));
      message.on("error", reject);
    });
    req.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${SOCKET_IDLE_TIMEOUT_MS} ms`));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
