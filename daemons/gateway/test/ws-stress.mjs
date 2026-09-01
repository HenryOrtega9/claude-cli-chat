/* Stress harness for Deferred item D: an intermittent WebSocket stall where
   the TCP/WS connection is accepted but the `hello` frame never arrives
   within the client's 10s wait, seen ~1 in 3 smoke-test runs and sometimes
   on the phone. See ws-client.mjs's Client constructor for the confirmed
   root cause of the smoke-test-side failures (a listener-registration race
   that silently dropped `hello` when it arrived coalesced with the 101
   response) and its fix. This harness exists to (a) prove that fix holds
   under load and (b) rule out or catch any SERVER-side contribution the
   single-connection smoke test can't surface: ticket races, exceptions in
   the upgrade handler, and split/chunked handshakes.

   Runs entirely against a THROWAWAY daemon -- never point this at the
   launchd instance other agents/the phone are using; rapid-fire connects
   against a shared instance would burn its ws-ticket TTL window and produce
   false positives having nothing to do with this bug.

   Usage:
     node daemons/gateway/test/ws-stress.mjs [rounds] [connsPerRound]
     WS_STRESS_BASE=http://127.0.0.1:8799 node daemons/gateway/test/ws-stress.mjs 300 4
     VAULT_GATEWAY_TRACE_WS=1 on the DAEMON (not this script) turns on the
     server-side trace log this harness's failures are meant to be read
     against. */

import { readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";

const BASE = (process.env.WS_STRESS_BASE || "http://127.0.0.1:8799").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const TOKEN_FILE = process.env.VAULT_GATEWAY_TOKEN_FILE || `${homedir()}/.config/vault-gateway/token`;
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
const ROUNDS = Number(process.argv[2] || 300);
const PER_ROUND = Number(process.argv[3] || 4); // concurrent connects per round
const HELLO_TIMEOUT_MS = 10_000; // matches the client's real-world wait, per the bug report

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function log(msg) { console.log(`[${((Date.now() - t0) / 1000).toFixed(3).padStart(8, " ")}s] ${msg}`); }
const t0 = Date.now();

async function api(method, path) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/* Mirrors ws-client.mjs's Client, WITH the pending-backlog fix, kept
   inline (not imported) so this harness stays a faithful from-scratch
   re-implementation per the task rather than trusting the file under test
   not to regress silently. `splitHandshake`: when true, the GET request is
   written one byte at a time (with a setImmediate between each) to force
   Node's HTTP parser to reassemble the request across many TCP reads --
   suspect (1) from the bug report, "handshake when the HTTP upgrade request
   arrives split across TCP chunks". */
function wsConnect(url, { splitHandshake = false } = {}) {
  const u = new URL(url);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + GUID).digest("base64");
  const connectedAt = process.hrtime.bigint();

  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: u.hostname, port: Number(u.port) });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("handshake timed out")); }, HELLO_TIMEOUT_MS);

    socket.on("error", err => { clearTimeout(timer); reject(err); });
    socket.on("connect", async () => {
      const req =
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n";
      if (!splitHandshake) {
        socket.write(req);
        return;
      }
      const bytes = Buffer.from(req, "utf8");
      for (let i = 0; i < bytes.length; i++) {
        socket.write(bytes.subarray(i, i + 1));
        // eslint-disable-next-line no-await-in-loop -- deliberately serialized to force N separate TCP writes
        await new Promise(r => setImmediate(r));
      }
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
      const acceptAt = process.hrtime.bigint();
      if (status !== "101") { socket.destroy(); reject(new Error(`handshake status ${status}\n${head}`)); return; }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (accept !== expectedAccept) { socket.destroy(); reject(new Error(`bad Sec-WebSocket-Accept`)); return; }
      resolve(new Client(socket, rest, connectedAt, acceptAt));
    };
    socket.on("data", onHandshakeData);
  });
}

class Client {
  constructor(socket, initial, connectedAt, acceptAt) {
    this.socket = socket;
    this.closed = false;
    this.messageCbs = new Set();
    this.pending = [];
    this.buf = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragChunks = [];
    this.connectedAt = connectedAt;
    this.acceptAt = acceptAt;
    socket.on("data", chunk => this.onData(chunk));
    socket.on("close", () => { this.closed = true; });
    socket.on("error", () => { this.closed = true; });
    if (initial.length > 0) this.onData(initial);
  }

  onMessage(cb) {
    this.messageCbs.add(cb);
    if (this.pending.length > 0) {
      const backlog = this.pending;
      this.pending = [];
      for (const text of backlog) cb(text);
    }
  }

  close() {
    try { this.socket.destroy(); } catch { /* ignore */ }
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); offset = 10; }
      if (this.buf.length < offset + len) return;
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.socket.write(frameClient(0xA, payload)); continue; }
      if (opcode === 0xA) continue;
      if (!fin || opcode === 0x0) continue; // fragmentation not needed for this harness's frames
      this.deliver(payload);
    }
  }

  deliver(payload) {
    const text = payload.toString("utf8");
    if (this.messageCbs.size === 0) { this.pending.push(text); return; }
    for (const cb of this.messageCbs) cb(text);
  }
}

function frameClient(opcode, payload) {
  const mask = randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/* A single connect-and-wait-for-hello attempt. `mode` selects which suspect
   this attempt is probing. */
async function attempt(mode) {
  const ticket = await api("POST", "/ws-ticket");
  if (ticket.status !== 200) return { ok: false, mode, reason: `ws-ticket ${ticket.status}` };

  if (mode === "duplicate-ticket") {
    /* Suspect (2): a single-use ticket redeemed by two racing connects, the
       way a reconnect timer firing at the same moment as a foreground
       trigger might if they ever shared a ticket. Expect exactly one success
       and one clean 401, never a hang. */
    const url = `${WS_BASE}/ws/${ticket.json.ticket}`;
    const [a, b] = await Promise.allSettled([wsConnect(url), wsConnect(url)]);
    const outcomes = [a, b].map(r => r.status === "fulfilled" ? "connected" : r.reason.message);
    const successes = outcomes.filter(o => o === "connected").length;
    for (const r of [a, b]) if (r.status === "fulfilled") r.value.close();
    if (successes !== 1) return { ok: false, mode, reason: `expected exactly 1 success, got ${successes}: ${outcomes.join(" | ")}` };
    return { ok: true, mode, helloMs: null };
  }

  const url = `${WS_BASE}/ws/${ticket.json.ticket}`;
  let ws;
  try {
    ws = await wsConnect(url, { splitHandshake: mode === "split-handshake" });
  } catch (err) {
    return { ok: false, mode, reason: `handshake: ${err.message}` };
  }
  const hello = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS);
    ws.onMessage(text => {
      clearTimeout(timer);
      let frame; try { frame = JSON.parse(text); } catch { resolve(null); return; }
      if (frame.t === "hello") resolve(frame);
    });
  });
  const helloAt = process.hrtime.bigint();
  ws.close();
  if (!hello) return { ok: false, mode, reason: `hello never arrived within ${HELLO_TIMEOUT_MS}ms` };
  const helloMs = Number(helloAt - ws.connectedAt) / 1e6;
  return { ok: true, mode, helloMs };
}

async function main() {
  log(`stress: ${ROUNDS} rounds x ${PER_ROUND} concurrent connects against ${BASE}`);
  const modes = ["plain", "plain", "split-handshake", "duplicate-ticket"];
  const results = [];
  for (let round = 0; round < ROUNDS; round++) {
    const batch = Array.from({ length: PER_ROUND }, (_, i) => attempt(modes[(round * PER_ROUND + i) % modes.length]));
    // eslint-disable-next-line no-await-in-loop -- rounds are deliberately sequential; connects WITHIN a round are concurrent
    const settled = await Promise.all(batch);
    for (const r of settled) results.push(r);
    const failedThisRound = settled.filter(r => !r.ok);
    if (failedThisRound.length > 0) {
      for (const f of failedThisRound) log(`round ${round} FAIL [${f.mode}] ${f.reason}`);
    }
  }

  const byMode = new Map();
  for (const r of results) {
    const m = byMode.get(r.mode) ?? { ok: 0, fail: 0, helloMs: [] };
    if (r.ok) { m.ok++; if (r.helloMs != null) m.helloMs.push(r.helloMs); } else m.fail++;
    byMode.set(r.mode, m);
  }

  console.log("");
  console.log("--- summary by mode ---");
  let totalFail = 0;
  for (const [mode, m] of byMode) {
    totalFail += m.fail;
    const total = m.ok + m.fail;
    const stats = m.helloMs.length > 0
      ? (() => {
          const sorted = [...m.helloMs].sort((a, b) => a - b);
          const p50 = sorted[Math.floor(sorted.length * 0.5)];
          const p99 = sorted[Math.floor(Math.min(sorted.length - 1, sorted.length * 0.99))];
          const max = sorted[sorted.length - 1];
          return `hello latency p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms`;
        })()
      : "";
    console.log(`${mode.padEnd(18)} ${m.ok}/${total} ok  ${stats}`);
  }
  console.log("");
  const totalRuns = results.length;
  console.log(totalFail === 0 ? `STRESS PASSED (${totalRuns}/${totalRuns})` : `STRESS FAILED (${totalRuns - totalFail}/${totalRuns}, ${totalFail} failures)`);
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(`STRESS ERRORED: ${err.stack ?? err.message}`);
  process.exit(1);
});
