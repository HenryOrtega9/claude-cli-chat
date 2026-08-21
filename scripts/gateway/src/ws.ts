/* Minimal RFC 6455 server-side WebSocket.

   Why not the `ws` package: the daemon speaks exactly one protocol shape —
   JSON text frames, one connection per phone, no extensions, no
   permessage-deflate, no subprotocol negotiation — and adding a runtime
   dependency to this repo's package.json is a merge hazard while other
   agents work in parallel. The client side needs no code at all: Node 24 and
   WKWebView both ship a standard WebSocket client.

   Implemented: the handshake, text/binary frames with continuation, close,
   ping/pong, and server-side fragmentation-free sends. Deliberately absent:
   extensions, and any masking on the server->client direction (RFC 6455 §5.1
   requires servers NOT to mask). */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/* RFC 6455 section 1.3. Verified byte-for-byte against a real browser: the
   RFC's own example key "dGhlIHNhbXBsZSBub25jZQ==" must hash to
   "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=". The previous value had the last two groups
   mis-split ("95CA-5AB0DC85B11F"), which no test could catch because
   test/ws-client.mjs carried the same typo — and which made every real browser
   reject the handshake with "Incorrect 'Sec-WebSocket-Accept' header value".
   That, not a broken client, is what the "Node's WebSocket fails every ws://
   handshake on this machine" note in CONTRACTS.md was actually observing. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* Frames larger than this are a protocol abuse, not a real message: the
   biggest thing the phone ever sends is a turn with an inline image, and the
   HTTP path handles attachments. Exceeding it closes the socket rather than
   letting a peer allocate unbounded memory. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type WsConnection = {
  readonly id: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  readonly closed: boolean;
};

let nextConnId = 1;

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = (req.headers.upgrade ?? "").toLowerCase();
  return upgrade === "websocket";
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
    body,
  );
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    rejectUpgrade(socket, 400, "bad_websocket_handshake");
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  /* Nagle would coalesce our small JSON frames into ~40ms batches, which on a
     token stream reads as stutter. The upgrade socket is always a net.Socket
     in practice; the cast is to Duplex's narrower type, not a guess. */
  (socket as Duplex & { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
  return new Connection(socket);
}

class Connection implements WsConnection {
  readonly id = nextConnId++;
  closed = false;

  private buf: Buffer = Buffer.alloc(0);
  private messageCbs: Array<(text: string) => void> = [];
  private closeCbs: Array<() => void> = [];
  /* Continuation-frame assembly: opcode of the message in progress plus its
     accumulated payload. */
  private fragOpcode = 0;
  private fragChunks: Buffer[] = [];
  private fragBytes = 0;

  constructor(private socket: Duplex) {
    socket.on("data", chunk => this.onData(chunk));
    socket.on("error", () => this.teardown());
    socket.on("close", () => this.teardown());
    socket.on("end", () => this.teardown());
  }

  onMessage(cb: (text: string) => void): void { this.messageCbs.push(cb); }
  onClose(cb: () => void): void {
    if (this.closed) { queueMicrotask(cb); return; }
    this.closeCbs.push(cb);
  }

  send(text: string): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    } catch {
      this.teardown();
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf8");
    try {
      this.socket.write(encodeFrame(0x8, payload));
    } catch { /* peer already gone */ }
    this.teardown();
    try { this.socket.end(); } catch { /* ignore */ }
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    const cbs = this.closeCbs.splice(0, this.closeCbs.length);
    for (const cb of cbs) {
      try { cb(); } catch { /* listener error is not ours to handle */ }
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = decodeFrame(this.buf);
      if (frame === null) return;              // need more bytes
      if (frame === "too_big") { this.close(1009, "frame_too_large"); return; }
      if (frame === "bad") { this.close(1002, "protocol_error"); return; }
      this.buf = this.buf.subarray(frame.consumed);
      this.handleFrame(frame.fin, frame.opcode, frame.payload);
      if (this.closed) return;
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x9: // ping -> pong with the same payload
        try { this.socket.write(encodeFrame(0xA, payload)); } catch { this.teardown(); }
        return;
      case 0xA: // pong; nothing to do, the liveness check is app-level
        return;
      case 0x8: // close
        this.close(1000, "");
        return;
      case 0x0: { // continuation
        if (this.fragOpcode === 0) { this.close(1002, "unexpected_continuation"); return; }
        this.fragChunks.push(payload);
        this.fragBytes += payload.length;
        if (this.fragBytes > MAX_FRAME_BYTES) { this.close(1009, "message_too_large"); return; }
        if (fin) this.deliverFragmented();
        return;
      }
      case 0x1:
      case 0x2: {
        if (this.fragOpcode !== 0) { this.close(1002, "interleaved_message"); return; }
        if (fin) {
          if (opcode === 0x1) this.deliver(payload);
          return;
        }
        this.fragOpcode = opcode;
        this.fragChunks = [payload];
        this.fragBytes = payload.length;
        return;
      }
      default:
        this.close(1002, "unknown_opcode");
    }
  }

  private deliverFragmented(): void {
    const opcode = this.fragOpcode;
    const payload = Buffer.concat(this.fragChunks, this.fragBytes);
    this.fragOpcode = 0;
    this.fragChunks = [];
    this.fragBytes = 0;
    if (opcode === 0x1) this.deliver(payload);
  }

  private deliver(payload: Buffer): void {
    const text = payload.toString("utf8");
    for (const cb of this.messageCbs) {
      try { cb(text); } catch (err) { console.error("[vault-gateway] ws message handler threw:", err); }
    }
  }
}

type DecodedFrame = { fin: boolean; opcode: number; payload: Buffer; consumed: number };

/* Returns null when more bytes are needed, "bad"/"too_big" on a protocol
   violation, otherwise the frame plus how many bytes it consumed. Client
   frames MUST be masked (RFC 6455 §5.1); an unmasked one is a protocol
   error, not something to tolerate. */
function decodeFrame(buf: Buffer): DecodedFrame | null | "bad" | "too_big" {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  if ((b0 & 0x70) !== 0) return "bad";          // no extensions negotiated -> RSV must be 0
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  if (!masked) return "bad";
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_FRAME_BYTES)) return "too_big";
    len = Number(big);
    offset += 8;
  }
  if (len > MAX_FRAME_BYTES) return "too_big";
  /* Control frames must be <=125 bytes and never fragmented. */
  if (opcode >= 0x8 && (len > 125 || !fin)) return "bad";
  if (buf.length < offset + 4 + len) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
  return { fin, opcode, payload, consumed: offset + len };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;                     // FIN set, no fragmentation
  return Buffer.concat([header, payload], header.length + len);
}
