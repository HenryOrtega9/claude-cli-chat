/* Dependency-free WebSocket client for the smoke test.

   Why not Node's global `WebSocket`: on this machine (Node 24.14) the built-in
   undici client fails every plaintext `ws://` handshake with a masked
   TypeError — including against a byte-identical copy of a public server's
   response that the SAME client accepts over `wss://`. `curl -i` shows our
   101 and Sec-WebSocket-Accept are correct, so the fault is in the client, not
   the daemon. Rather than test around a broken client, this speaks the
   protocol directly: it is ~120 lines, it masks its frames the way RFC 6455
   requires of a client, and it is the mirror image of scripts/gateway/src/ws.ts
   — so a framing bug on either side shows up as a test failure instead of
   hiding behind a shared library.

   Only what the test needs: text frames, close, ping/pong replies,
   continuation reassembly. */

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F";

export function wsConnect(url, { timeoutMs = 15_000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol === "wss:";
  const port = u.port ? Number(u.port) : (secure ? 443 : 80);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + GUID).digest("base64");

  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ host: u.hostname, port, servername: u.hostname })
      : netConnect({ host: u.hostname, port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ws handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("error", err => { clearTimeout(timer); reject(err); });
    socket.on(secure ? "secureConnect" : "connect", () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });

    let buf = Buffer.alloc(0);
    const onHandshakeData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const head = buf.subarray(0, sep).toString("latin1");
      const rest = buf.subarray(sep + 4);
      socket.removeListener("data", onHandshakeData);
      clearTimeout(timer);

      const status = /^HTTP\/1\.1 (\d+)/.exec(head)?.[1];
      if (status !== "101") { socket.destroy(); reject(new Error(`handshake status ${status}\n${head}`)); return; }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (accept !== expectedAccept) { socket.destroy(); reject(new Error(`bad Sec-WebSocket-Accept: ${accept} != ${expectedAccept}`)); return; }

      resolve(new Client(socket, rest));
    };
    socket.on("data", onHandshakeData);
  });
}

class Client {
  constructor(socket, initial) {
    this.socket = socket;
    this.closed = false;
    this.messageCbs = new Set();
    this.closeCbs = new Set();
    this.buf = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragChunks = [];
    socket.on("data", chunk => this.onData(chunk));
    socket.on("close", () => this.teardown());
    socket.on("error", () => this.teardown());
    if (initial.length > 0) this.onData(initial);
  }

  onMessage(cb) { this.messageCbs.add(cb); return () => this.messageCbs.delete(cb); }
  onClose(cb) { this.closeCbs.add(cb); }

  send(text) {
    if (this.closed) return;
    this.socket.write(this.frame(0x1, Buffer.from(text, "utf8")));
  }

  close() {
    return new Promise(resolve => {
      if (this.closed) { resolve(); return; }
      this.closeCbs.add(resolve);
      try {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1000, 0);
        this.socket.write(this.frame(0x8, payload));
      } catch { /* peer already gone */ }
      this.socket.end();
      setTimeout(() => { this.socket.destroy(); this.teardown(); resolve(); }, 2000).unref?.();
    });
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
    this.closeCbs.clear();
  }

  /* Client frames MUST be masked (RFC 6455 §5.1) — a server that accepts an
     unmasked one is broken, so this always masks. */
  frame(opcode, payload) {
    const mask = randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        mask = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return;
      let payload = this.buf.subarray(offset, offset + len);
      if (mask) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = this.buf.subarray(offset + len);

      if (opcode === 0x8) { this.socket.end(); this.teardown(); return; }
      if (opcode === 0x9) { this.socket.write(this.frame(0xA, payload)); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x0) {
        this.fragChunks.push(payload);
        if (fin) { this.deliver(this.fragOpcode, Buffer.concat(this.fragChunks)); this.fragOpcode = 0; this.fragChunks = []; }
        continue;
      }
      if (!fin) { this.fragOpcode = opcode; this.fragChunks = [payload]; continue; }
      this.deliver(opcode, payload);
    }
  }

  deliver(opcode, payload) {
    if (opcode !== 0x1) return;
    const text = payload.toString("utf8");
    for (const cb of this.messageCbs) cb(text);
  }
}
