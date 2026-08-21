/* End-to-end smoke test for the Vault Gateway daemon.

   Drives a real `claude` child through a real WebSocket and asserts the
   contract the iOS client depends on:

     1. POST /tabs, POST /ws-ticket, connect /ws/<ticket>, subscribe
     2. A plain turn produces assistant text and a turn_done frame
     3. A tool-using turn in permissionMode "default" produces an
        approval_request; approving it lets the tool_result reach the stream
        and the turn complete
     4. Disconnect, reconnect with `since`, and the replay has no gaps and no
        duplicates (seq is contiguous across the cut)
     5. GET /tabs/:id returns the persisted tab with the conversation in it
     6. The HTTP replay endpoint agrees with the socket
     7. REGRESSION: a tab created but never given a turn survives a daemon
        restart and its FIRST turn still succeeds. The daemon used to mark
        every rehydrated tab as having an established session, so that tab
        spawned `--resume <uuid>` for a conversation the CLI had never
        created, exited 1, and the turn surfaced as error_during_execution.
        Needs the launchd job (skipped otherwise, or with --no-restart).

   The WebSocket client is ./ws-client.mjs (see its header for why the built-in
   one is unusable here), so this needs no dependencies.

   Usage:
     node scripts/gateway/test/smoke.mjs [baseUrl]
     BASE=http://127.0.0.1:8788 node scripts/gateway/test/smoke.mjs

   The base URL may be plain http through `tailscale serve`; the test derives
   the ws:// or wss:// origin from it, which is exactly how it doubles as the
   proof that WebSocket upgrade survives serve. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { wsConnect } from "./ws-client.mjs";

const BASE = (process.argv[2] || process.env.BASE || "http://127.0.0.1:8788").replace(/\/$/, "");
const TOKEN_FILE = process.env.VAULT_GATEWAY_TOKEN_FILE || `${homedir()}/.config/vault-gateway/token`;
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
const WS_BASE = BASE.replace(/^http/, "ws");
const LAUNCHD_LABEL = "dev.claude-cli-chat.vault-gateway";
const ALLOW_RESTART = !process.argv.includes("--no-restart");

let failures = 0;
const t0 = Date.now();

function stamp() {
  return `${String((Date.now() - t0) / 1000).padStart(6, " ")}s`;
}
function log(msg) { console.log(`[${stamp()}] ${msg}`); }
function pass(msg) { console.log(`[${stamp()}] PASS  ${msg}`); }
function fail(msg) { failures++; console.log(`[${stamp()}] FAIL  ${msg}`); }
function assert(cond, msg) { cond ? pass(msg) : fail(msg); return cond; }

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/* A connected, subscribed socket that records every frame it sees. */
async function connect(since) {
  const ticket = await api("POST", "/ws-ticket");
  if (ticket.status !== 200) throw new Error(`ws-ticket failed: ${ticket.status} ${JSON.stringify(ticket.json)}`);
  const ws = await wsConnect(`${WS_BASE}/ws/${ticket.json.ticket}`);
  const frames = [];
  const listeners = new Set();
  ws.onMessage(text => {
    const frame = JSON.parse(text);
    frames.push(frame);
    for (const l of listeners) l(frame);
  });
  const hello = await waitFor(frames, listeners, f => f.t === "hello", 10_000, "hello");
  ws.send(JSON.stringify({ t: "subscribe", tabs: "all", since: since ?? {} }));
  return {
    ws, frames, listeners, hello,
    waitFor: (pred, timeoutMs, label) => waitFor(frames, listeners, pred, timeoutMs, label),
    close: () => ws.close(),
  };
}

function waitFor(frames, listeners, pred, timeoutMs = 120_000, label = "frame") {
  const existing = frames.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
    const listener = frame => {
      if (!pred(frame)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(frame);
    };
    listeners.add(listener);
  });
}

function assistantTextIn(frames) {
  let text = "";
  for (const f of frames) {
    if (f.t !== "event" || f.payload?.type !== "assistant") continue;
    for (const block of f.payload.message?.content ?? []) {
      if (block.type === "text") text += block.text;
    }
  }
  return text;
}

/* Restarts the launchd daemon and waits for /health to report ready again.
   Returns false when the job isn't loaded (a hand-started daemon, or another
   machine), which the caller reports as a skip rather than a failure. */
async function restartDaemon() {
  if (!ALLOW_RESTART) return false;
  const uid = process.getuid();
  try {
    execFileSync("/bin/launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  } catch {
    return false;
  }
  execFileSync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  const deadline = Date.now() + 120_000;
  /* The store lives on iCloud Drive; a cold read has been measured at ~33 s,
     which is exactly why /health distinguishes "starting" from being down. */
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const h = await api("GET", "/health");
      if (h.status === 200 && h.json.state === "ready") return true;
    } catch { /* socket not back yet */ }
  }
  throw new Error("daemon did not come back ready within 120s");
}

async function main() {
  log(`base=${BASE} ws=${WS_BASE}`);

  /* --- 0. health --- */
  const unauth = await fetch(`${BASE}/health`);
  assert(unauth.status === 401, `GET /health without a token -> 401 (got ${unauth.status})`);
  const health = await api("GET", "/health");
  assert(health.status === 200 && health.json.state === "ready", `GET /health with a token -> 200 ready (got ${health.status} ${health.json.state})`);

  /* --- 1. tab + socket --- */
  /* Sweep tabs a previous aborted run left behind, so the frame counts and
     hello payload below describe this run only. */
  const existing = await api("GET", "/tabs");
  for (const tab of existing.json.tabs ?? []) {
    if (tab.title === "smoke") await api("DELETE", `/tabs/${tab.id}`);
  }

  const created = await api("POST", "/tabs", { title: "smoke", model: "haiku", permissionMode: "default" });
  assert(created.status === 200 && created.json.id, `POST /tabs -> ${JSON.stringify(created.json)}`);
  const tabId = created.json.id;
  assert(/^[0-9a-f-]{36}$/.test(created.json.sessionId), `sessionId is a server-generated uuid (${created.json.sessionId})`);

  const c1 = await connect();
  assert(c1.hello.t === "hello" && c1.hello.seq === 0 && c1.hello.tab === null, "hello frame arrives with tab=null seq=0");
  log(`hello: ${JSON.stringify(c1.hello.payload).slice(0, 160)}`);

  /* --- 2. plain turn --- */
  log("turn 1: 'Reply with exactly the word PONG.'");
  const turn1 = await api("POST", `/tabs/${tabId}/turn`, {
    blocks: [{ type: "text", text: "Reply with exactly the word PONG." }],
    clientTurnId: "smoke-1",
  });
  assert(turn1.status === 202, `POST turn -> 202 (got ${turn1.status} ${JSON.stringify(turn1.json)})`);

  const pong = await c1.waitFor(
    f => f.tab === tabId && f.t === "event" && f.payload?.type === "assistant"
      && (f.payload.message?.content ?? []).some(b => b.type === "text" && /PONG/i.test(b.text)),
    180_000, "assistant text containing PONG");
  assert(!!pong, `event frame carries assistant text PONG (seq ${pong.seq})`);
  log(`   assistant said: ${JSON.stringify(assistantTextIn(c1.frames).trim())}`);

  const done1 = await c1.waitFor(f => f.tab === tabId && f.t === "turn_done", 180_000, "turn_done");
  assert(done1.payload.turnId === "smoke-1", `turn_done carries the clientTurnId (${done1.payload.turnId})`);
  log(`   turn_done: ${JSON.stringify(done1.payload).slice(0, 200)}`);

  /* --- 3. tool turn + approval ---
     Finding a tool call that RELIABLY prompts took two tries: Read inside the
     cwd is auto-approved in "default" mode, and `Bash(echo …)` is waved
     through by the CLI's safe-command classifier even though it is not in the
     vault's allowlist. A Read of a path outside the working directory is
     gated by the sandbox itself, so it prompts regardless of what the user's
     allowlist happens to contain. */
  log("turn 2: tool use requiring approval");
  const turn2 = await api("POST", `/tabs/${tabId}/turn`, {
    blocks: [{ type: "text", text: "Use the Read tool to read the file /etc/hosts and tell me its first line. Use no other tool." }],
    clientTurnId: "smoke-2",
  });
  assert(turn2.status === 202, `POST tool turn -> 202 (got ${turn2.status})`);

  /* Race the approval against the turn ending: if the tool got auto-approved
     the test must say so rather than sit on a 3-minute timeout. */
  const approvalOrDone = await c1.waitFor(
    f => f.tab === tabId && (f.t === "approval_request" || (f.t === "turn_done" && f.seq > done1.seq)),
    180_000, "approval_request or turn_done");
  if (approvalOrDone.t !== "approval_request") {
    fail(`turn completed with no approval_request (subtype ${approvalOrDone.payload.subtype}) — the tool was auto-approved`);
    throw new Error("no approval to exercise");
  }
  const approval = approvalOrDone;
  assert(!!approval.payload.request_id, `approval_request arrived for ${approval.payload.tool_name} (request_id ${approval.payload.request_id})`);
  log(`   approval payload: ${JSON.stringify(approval.payload).slice(0, 220)}`);

  const approved = await api("POST", `/tabs/${tabId}/approve`, { request_id: approval.payload.request_id, allowed: true });
  assert(approved.status === 200, `POST /approve -> 200 (got ${approved.status} ${JSON.stringify(approved.json)})`);

  const resolved = await c1.waitFor(f => f.tab === tabId && f.t === "approval_resolved", 30_000, "approval_resolved");
  assert(resolved.payload.allowed === true && resolved.payload.by === "client", `approval_resolved {allowed:true, by:"client"} (${JSON.stringify(resolved.payload)})`);

  /* Wire gotcha #3: tool_result blocks ride inside a synthetic `user` event. */
  const toolResult = await c1.waitFor(
    f => f.tab === tabId && f.t === "event" && f.payload?.type === "user"
      && (f.payload.message?.content ?? []).some(b => b.type === "tool_result"),
    180_000, "tool_result inside a user event");
  assert(!!toolResult, `tool_result reached the stream (seq ${toolResult.seq})`);

  const done2 = await c1.waitFor(f => f.tab === tabId && f.t === "turn_done" && f.seq > done1.seq, 180_000, "second turn_done");
  assert(done2.payload.subtype === "success", `tool turn completed (subtype ${done2.payload.subtype})`);

  /* --- 4. disconnect / reconnect with since --- */
  const cutoffSeq = Math.max(1, Math.floor(done1.seq));
  const beforeClose = c1.frames.filter(f => f.tab === tabId).map(f => f.seq);
  await c1.close();
  log(`disconnected after ${beforeClose.length} tab frames (lastSeq ${Math.max(...beforeClose)})`);

  const c2 = await connect({ [tabId]: cutoffSeq });
  /* Give the replay a moment to drain before inspecting it. */
  await new Promise(r => setTimeout(r, 1500));
  const replayed = c2.frames.filter(f => f.tab === tabId).map(f => f.seq);
  const expected = [];
  for (let s = cutoffSeq + 1; s <= Math.max(...beforeClose); s++) expected.push(s);
  const missing = expected.filter(s => !replayed.includes(s));
  const dupes = replayed.filter((s, i) => replayed.indexOf(s) !== i);
  const tooOld = replayed.filter(s => s <= cutoffSeq);
  assert(missing.length === 0, `replay has no gaps (expected seq ${cutoffSeq + 1}..${Math.max(...beforeClose)}, missing ${missing.length})`);
  assert(dupes.length === 0, `replay has no duplicates (${dupes.length} dupes)`);
  assert(tooOld.length === 0, `replay sends nothing at or below since=${cutoffSeq} (${tooOld.length} stale frames)`);
  log(`   replayed ${replayed.length} frames, seq ${Math.min(...replayed)}..${Math.max(...replayed)}`);

  const helloTab = c2.hello.payload.tabs.find(t => t.id === tabId);
  assert(helloTab && helloTab.lastSeq >= Math.max(...beforeClose), `hello reports the tab's lastSeq (${helloTab?.lastSeq})`);

  /* --- 5. persisted tab --- */
  const stored = await api("GET", `/tabs/${tabId}`);
  assert(stored.status === 200, `GET /tabs/:id -> 200`);
  const roles = (stored.json.messages ?? []).map(m => m.role);
  assert(roles.filter(r => r === "user").length === 2, `persisted 2 user turns (got ${roles.filter(r => r === "user").length})`);
  assert(roles.includes("assistant"), "persisted assistant turns");
  assert(stored.json.sessionId === created.json.sessionId, "persisted sessionId matches the one issued at creation");
  const toolCalls = (stored.json.messages ?? []).flatMap(m => m.toolCalls ?? []);
  assert(toolCalls.some(t => t.status === "completed"), `persisted a completed tool call (${toolCalls.map(t => `${t.name}:${t.status}`).join(", ") || "none"})`);
  log(`   stored tab: ${stored.json.messages.length} messages, title ${JSON.stringify(stored.json.title)}`);

  /* --- 6. HTTP replay endpoint agrees with the socket --- */
  const events = await api("GET", `/tabs/${tabId}/events?since=${cutoffSeq}&limit=5000`);
  assert(events.status === 200 && !events.json.evicted, `GET /tabs/:id/events?since -> 200, evicted=${events.json.evicted}`);
  assert(events.json.events.every(f => f.seq > cutoffSeq), "events endpoint honors `since`");

  /* --- cleanup --- */
  await c2.close();
  const deleted = await api("DELETE", `/tabs/${tabId}`);
  assert(deleted.status === 200, "DELETE /tabs/:id -> 200");

  /* --- 7. regression: cold tab across a daemon restart ---
     A tab that was created and never used has a session id and no
     conversation. Before the fix in engine.ts, restore() marked it
     sessionEstablished, so its first spawn passed `--resume <uuid>`, the CLI
     exited 1 with "No conversation found with session ID", and the turn came
     back as error_during_execution, permanently, since every later spawn
     repeated it. */
  log("regression: cold tab, daemon restart, first turn");
  const cold = await api("POST", "/tabs", { title: "smoke-cold", model: "haiku", permissionMode: "acceptEdits" });
  assert(cold.status === 200 && cold.json.id, `POST /tabs (cold) -> ${JSON.stringify(cold.json)}`);
  const coldId = cold.json.id;

  let restarted = false;
  try {
    restarted = await restartDaemon();
  } catch (err) {
    fail(`daemon restart: ${err.message}`);
  }

  if (!restarted) {
    log(`   SKIP restart (launchd job ${LAUNCHD_LABEL} not loaded, or --no-restart)`);
    await api("DELETE", `/tabs/${coldId}`);
  } else {
    log("   daemon restarted, /health ready");
    const rehydrated = await api("GET", `/tabs/${coldId}`);
    assert(rehydrated.status === 200, `cold tab survived the restart (GET /tabs/:id -> ${rehydrated.status})`);
    assert(rehydrated.json?.sessionId === cold.json.sessionId, "rehydrated tab kept its session id");

    const c3 = await connect();
    const coldTurn = await api("POST", `/tabs/${coldId}/turn`, {
      blocks: [{ type: "text", text: "Reply with exactly the word PONG." }],
      clientTurnId: "smoke-cold-1",
    });
    assert(coldTurn.status === 202, `POST cold turn -> 202 (got ${coldTurn.status} ${JSON.stringify(coldTurn.json)})`);
    const coldDone = await c3.waitFor(f => f.tab === coldId && f.t === "turn_done", 180_000, "cold turn_done");
    assert(
      coldDone.payload.subtype === "success",
      `first turn on a rehydrated never-run tab succeeds (subtype ${coldDone.payload.subtype})`,
    );
    const coldText = assistantTextIn(c3.frames.filter(f => f.tab === coldId));
    assert(/PONG/i.test(coldText), `cold tab produced assistant text (${JSON.stringify(coldText.trim().slice(0, 60))})`);
    await c3.close();
    const coldDeleted = await api("DELETE", `/tabs/${coldId}`);
    assert(coldDeleted.status === 200, "DELETE cold tab -> 200");
  }

  console.log("");
  console.log(failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures} assertion${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(`\nSMOKE ERRORED: ${err.stack ?? err.message}`);
  process.exit(1);
});
