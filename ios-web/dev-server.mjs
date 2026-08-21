/* Dev host for the Vault Gateway client, so the whole thing can be driven in
   a desktop browser with no Xcode in the loop.

   Two jobs:

     1. Serve `ios/Web/` (whatever `npm run build:ios` just wrote) as static
        files, exactly as the native WKURLSchemeHandler does.
     2. Reverse-proxy `/gw/*` to the gateway daemon, INCLUDING the WebSocket
        upgrade, so the page and the daemon are same-origin.

   Why the proxy exists at all: the daemon emits no CORS headers (it was
   written for a WKWebView, which is same-origin with a custom scheme handler),
   so a page served from localhost cannot fetch it directly. Proxying makes
   every request first-party and the browser stops caring.

   The upgrade is handled with a raw socket pipe rather than a WebSocket
   client library, deliberately: node 24's built-in WebSocket fails every
   plaintext ws:// handshake against this daemon (see CONTRACTS.md), and a
   byte pipe never parses a frame, so it cannot inherit that bug.

   Usage:
     node ios-web/dev-server.mjs                       # gateway on 127.0.0.1:8788
     node ios-web/dev-server.mjs http://100.96.112.74:8788
     PORT=5173 node ios-web/dev-server.mjs

   Then, in the browser console, once:
     localStorage.setItem("vaultgw.dev.token", "<contents of ~/.config/vault-gateway/token>")

   This file is a dev tool and is never bundled. It is the one place in
   `ios-web/` allowed to import node builtins. */

import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import process from "node:process";

const TARGET = new URL(process.argv[2] || process.env.GATEWAY || "http://127.0.0.1:8788");
const PORT = Number(process.env.PORT || 5173);
const WEB_ROOT = resolve(process.cwd(), "ios/Web");
const PREFIX = "/gw";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

/* Static file resolution. `normalize` on the decoded path plus the prefix
   check below is what keeps `/../../etc/passwd` inside WEB_ROOT. */
async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_ROOT, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      /* The whole point of this server is iterating; never let the browser
         hold a stale renderer.js. */
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

/* Plain HTTP proxy for /gw/*. Headers ride through verbatim so the page's own
   Authorization header reaches the daemon, and the response is copied back
   status-line first. node's own http client is used here (rather than the raw
   socket pipe the upgrade path needs) because it handles chunked encoding and
   connection reuse correctly — hand-rolling that produced empty responses on
   POSTs under load. */
function proxyHttp(req, res) {
  const path = req.url.slice(PREFIX.length) || "/";
  const upstream = httpRequest(
    {
      host: TARGET.hostname,
      port: Number(TARGET.port || 80),
      method: req.method,
      path,
      headers: { ...req.headers, host: TARGET.host },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_failed", message: String(err.message ?? err) }));
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  if (req.url.startsWith(`${PREFIX}/`) || req.url === PREFIX) {
    proxyHttp(req, res);
    return;
  }
  void serveStatic(req, res);
});

/* WebSocket upgrade: replay the client's request line and headers upstream,
   then pipe both directions byte for byte. Nothing here understands RFC 6455,
   which is exactly why it cannot get it wrong. */
server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith(`${PREFIX}/`)) {
    socket.destroy();
    return;
  }
  const path = req.url.slice(PREFIX.length);
  const upstream = netConnect({ host: TARGET.hostname, port: Number(TARGET.port || 80) }, () => {
    const lines = [`GET ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries({ ...req.headers, host: TARGET.host })) {
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ios-web dev server  http://127.0.0.1:${PORT}`);
  console.log(`  static            ${WEB_ROOT}`);
  console.log(`  proxy ${PREFIX}/*        ${TARGET.origin}`);
  console.log("");
  console.log("In the page console, once:");
  console.log(`  localStorage.setItem("vaultgw.dev.token", "<~/.config/vault-gateway/token>")`);
});
