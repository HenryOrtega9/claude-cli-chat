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
     node daemons/gateway/test/smoke.mjs [baseUrl]
     BASE=http://127.0.0.1:8788 node daemons/gateway/test/smoke.mjs

   The base URL may be plain http through `tailscale serve`; the test derives
   the ws:// or wss:// origin from it, which is exactly how it doubles as the
   proof that WebSocket upgrade survives serve. */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
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

/* D5 (registry.ts remove()) deliberately leaves a closed tab's conversation
   + meta sidecar on disk so History can list and restore it — see
   docs/ios-gateway/CONTRACTS.md. That's correct product behavior, but this
   test's own throwaway tabs would otherwise accumulate in the REAL vault's
   History forever, one smoke run at a time. The daemon has no HTTP route for
   a genuine permanent delete (by design — nothing in the product needs one
   yet), but the test runs on the same machine as the daemon, so it can just
   unlink what it created directly, using /health's own `cwd` to find the
   store. Best-effort: a file already gone (e.g. a tab this run never
   actually reopened) is not an error. */
function purgeConversationFiles(vaultCwd, ids) {
  const dir = `${vaultCwd}/.claude-cli-chat/ios/conversations`;
  for (const id of ids) {
    if (!id) continue;
    for (const suffix of [".json", ".meta.json"]) {
      try { rmSync(`${dir}/${id}${suffix}`, { force: true }); } catch { /* best-effort */ }
    }
  }
}

async function main() {
  log(`base=${BASE} ws=${WS_BASE}`);
  const testTabIds = [];

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
  testTabIds.push(tabId);
  /* D4 fix: a tab POST /tabs just minted has an id but no ESTABLISHED session
     yet — no turn has run, so the CLI has never seen it. Exposing the real
     internal uuid here anyway (as the daemon used to) is exactly what
     permanently locked the phone's incognito toggle: TabController mounts
     with `state.sessionId` non-null before the tab has anything to protect.
     `sessionId` only turns into a real uuid once GET /tabs/:id (or another
     POST /tabs response) reflects an established one — see below, after
     turn 1's system/init. */
  assert(created.json.sessionId === null, `fresh POST /tabs reports sessionId:null, not established yet (${JSON.stringify(created.json.sessionId)})`);

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
  /* Established now: turn 1's `system/init` landed, so GET /tabs/:id reports
     the real internal uuid rather than the null POST /tabs saw. Captured for
     the clear regression below, which needs to assert the id actually
     rotates. */
  const establishedSessionId = stored.json.sessionId;
  assert(/^[0-9a-f-]{36}$/.test(establishedSessionId), `sessionId is established after turn 1 (${establishedSessionId})`);
  const toolCalls = (stored.json.messages ?? []).flatMap(m => m.toolCalls ?? []);
  assert(toolCalls.some(t => t.status === "completed"), `persisted a completed tool call (${toolCalls.map(t => `${t.name}:${t.status}`).join(", ") || "none"})`);
  log(`   stored tab: ${stored.json.messages.length} messages, title ${JSON.stringify(stored.json.title)}`);

  /* --- 5b. composer draft round-trips through PATCH/GET ---
     `draft` is the one StoredTab field a client legitimately writes back —
     see RemoteFileStorage.applyConversation() and engine.ts patch(). Not
     engine-affecting: setting it must never drop the live child or otherwise
     disturb the tab's status. */
  log("draft persistence: PATCH /tabs/:id {draft}");
  assert(stored.json.draft === undefined, `fresh tab has no draft yet (got ${JSON.stringify(stored.json.draft)})`);
  const statusBeforeDraft = (await api("GET", "/health")).json.tabs.find(t => t.id === tabId)?.status;
  const draftPatch = await api("PATCH", `/tabs/${tabId}`, { draft: "unsent composer text" });
  assert(draftPatch.status === 200, `PATCH {draft} -> 200 (got ${draftPatch.status} ${JSON.stringify(draftPatch.json)})`);
  const withDraft = await api("GET", `/tabs/${tabId}`);
  assert(withDraft.json.draft === "unsent composer text", `GET reflects the patched draft (got ${JSON.stringify(withDraft.json.draft)})`);
  const statusAfterDraft = (await api("GET", "/health")).json.tabs.find(t => t.id === tabId)?.status;
  assert(statusAfterDraft === statusBeforeDraft, `draft patch is not engine-affecting (status stayed ${statusAfterDraft})`);
  const draftClearPatch = await api("PATCH", `/tabs/${tabId}`, { draft: "" });
  assert(draftClearPatch.status === 200, `PATCH {draft:""} -> 200 (got ${draftClearPatch.status})`);
  const draftCleared = await api("GET", `/tabs/${tabId}`);
  assert(!draftCleared.json.draft, `empty-string draft clears back to falsy (got ${JSON.stringify(draftCleared.json.draft)})`);
  /* Leave a draft in place so the clear regression below can assert it gets
     wiped too. */
  await api("PATCH", `/tabs/${tabId}`, { draft: "should not survive /clear" });

  /* --- 6. HTTP replay endpoint agrees with the socket --- */
  const events = await api("GET", `/tabs/${tabId}/events?since=${cutoffSeq}&limit=5000`);
  assert(events.status === 200 && !events.json.evicted, `GET /tabs/:id/events?since -> 200, evicted=${events.json.evicted}`);
  assert(events.json.events.every(f => f.seq > cutoffSeq), "events endpoint honors `since`");

  /* --- 6b. REGRESSION: POST /tabs/:id/clear really clears ---
     "New chat" on the phone used to be a local wipe (or a DELETE + POST of a
     brand-new tab). The daemon kept the messages, the events spill and the
     session id either way, so the conversation came back on the next
     GET /tabs/:id and the next turn `--resume`d what the user had discarded.
     Assert all four halves of the fix: the projection is empty, the id is new,
     the ring no longer serves the old history, and the tab is still there. */
  log("regression: POST /tabs/:id/clear");
  const beforeClear = await api("GET", `/tabs/${tabId}`);
  const clearSeqFloor = beforeClear.json.lastSeq;
  const cleared = await api("POST", `/tabs/${tabId}/clear`);
  assert(cleared.status === 200, `POST /tabs/:id/clear -> 200 (got ${cleared.status} ${JSON.stringify(cleared.json)})`);
  /* Unlike POST /tabs / GET /tabs / GET /tabs/:id (D4 fix, above), the clear
     route deliberately keeps reporting the REAL internal id rather than the
     established-gated one: this assertion needs it to prove the id actually
     rotated away from the one turn 1 established, which is the whole point
     of clear() minting a fresh uuid instead of reusing the discarded one. */
  assert(
    /^[0-9a-f-]{36}$/.test(cleared.json.sessionId) && cleared.json.sessionId !== establishedSessionId,
    `clear mints a NEW session id (${establishedSessionId} -> ${cleared.json.sessionId})`,
  );

  const afterClear = await api("GET", `/tabs/${tabId}`);
  assert(afterClear.status === 200, `cleared tab still exists (GET -> ${afterClear.status})`);
  assert((afterClear.json.messages ?? []).length === 0, `conversation is empty (${(afterClear.json.messages ?? []).length} messages)`);
  assert(!afterClear.json.draft, `clear wipes the draft too (got ${JSON.stringify(afterClear.json.draft)})`);
  /* D4: the new id isn't ESTABLISHED yet either — clear() reset the tab back
     to "minted, never spawned", exactly the state a fresh POST /tabs leaves
     a tab in, so GET /tabs/:id reports null until the next turn's
     system/init lands (asserted after that turn, below). */
  assert(afterClear.json.sessionId === null, `persisted sessionId is null again post-clear, not established (${JSON.stringify(afterClear.json.sessionId)})`);
  assert(afterClear.json.title === "New chat", `title reset (${JSON.stringify(afterClear.json.title)})`);
  assert(afterClear.json.lastSeq >= cleared.json.lastSeq, `lastSeq kept monotonic across the clear (${afterClear.json.lastSeq})`);
  assert(
    (await api("GET", "/tabs")).json.tabs.some(t => t.id === tabId),
    "the tab keeps its slot in the index (clear is not a delete)",
  );

  /* The old history must be unreachable, not merely hidden: a client holding a
     pre-clear cursor has to be told to resync. */
  const staleReplay = await api("GET", `/tabs/${tabId}/events?since=${Math.max(0, clearSeqFloor - 2)}&limit=5000`);
  assert(staleReplay.json.evicted === true, `a pre-clear cursor is evicted (evicted=${staleReplay.json.evicted})`);
  const freshReplay = await api("GET", `/tabs/${tabId}/events?since=${afterClear.json.lastSeq}&limit=5000`);
  assert(
    freshReplay.status === 200 && !freshReplay.json.evicted && freshReplay.json.events.length === 0,
    `a post-clear cursor is in sync (evicted=${freshReplay.json.evicted}, ${freshReplay.json.events?.length} events)`,
  );

  /* The sibling behaviour the bug report called out: the next turn must NOT
     carry the old context. The pre-clear conversation contains "PONG" and a
     Read of /etc/hosts; a resumed session answers this from that history, a
     fresh one cannot. */
  const c2b = await connect({ [tabId]: afterClear.json.lastSeq });
  /* acceptEdits so a stray tool call cannot park this turn on an approval the
     test never answers; the assertion below is about memory, not permissions. */
  await api("PATCH", `/tabs/${tabId}`, { permissionMode: "acceptEdits" });
  const afterTurn = await api("POST", `/tabs/${tabId}/turn`, {
    blocks: [{ type: "text", text: "Without using any tool: what was the last word I asked you to reply with? If this is the first thing I have said to you, reply with exactly NOHISTORY." }],
    clientTurnId: "smoke-cleared-1",
  });
  assert(afterTurn.status === 202, `turn on a cleared tab -> 202 (got ${afterTurn.status} ${JSON.stringify(afterTurn.json)})`);
  const clearedDone = await c2b.waitFor(f => f.tab === tabId && f.t === "turn_done" && f.payload.turnId === "smoke-cleared-1", 180_000, "cleared-tab turn_done");
  assert(clearedDone.payload.subtype === "success", `cleared tab spawns cleanly, no failed --resume (subtype ${clearedDone.payload.subtype})`);
  const clearedText = assistantTextIn(c2b.frames.filter(f => f.tab === tabId));
  assert(
    /NOHISTORY/i.test(clearedText) && !/PONG/i.test(clearedText),
    `the fresh session has no memory of the discarded conversation (${JSON.stringify(clearedText.trim().slice(0, 120))})`,
  );
  await c2b.close();

  /* Now that a turn ran under it, the new id clear() minted is established —
     GET /tabs/:id should report the SAME uuid clear()'s own response did. */
  const afterClearedTurn = await api("GET", `/tabs/${tabId}`);
  assert(
    afterClearedTurn.json.sessionId === cleared.json.sessionId,
    `post-clear session becomes established after its first turn (${afterClearedTurn.json.sessionId} === ${cleared.json.sessionId})`,
  );

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
  testTabIds.push(coldId);

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
    /* Both null: a never-spawned tab has no ESTABLISHED session before the
       restart (D4) and none after it either — a cold rehydrate must not
       manufacture one, which is exactly the bug this whole section guards
       against (see the header comment). */
    assert(rehydrated.json?.sessionId === cold.json.sessionId, `rehydrated tab still reports no established session (${rehydrated.json?.sessionId})`);

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

  /* --- 8. regression: History over the gateway (D5) ---
     DELETE /tabs/:id used to be a real delete: the conversation file, its
     meta sidecar and the tab's slot in History all vanished together. That
     made "closed but still in History, restorable" — table stakes for a
     chat History feature — impossible on the phone: GET /tabs only ever
     lists the OPEN index. registry.ts remove() now leaves the conversation
     file on disk; GET /conversations lists it regardless of open/closed;
     POST /tabs/:id/reopen resurrects it into the OPEN index on demand. */
  log("regression: History (GET /conversations, DELETE keeps the file, POST reopen)");
  const hist = await api("POST", "/tabs", { title: "smoke-history", model: "haiku", permissionMode: "acceptEdits" });
  assert(hist.status === 200 && hist.json.id, `POST /tabs (history) -> ${JSON.stringify(hist.json)}`);
  const histId = hist.json.id;
  testTabIds.push(histId);

  const c4 = await connect();
  const histTurn = await api("POST", `/tabs/${histId}/turn`, {
    blocks: [{ type: "text", text: "Reply with exactly the word PONG." }],
    clientTurnId: "smoke-history-1",
  });
  assert(histTurn.status === 202, `POST history turn -> 202 (got ${histTurn.status})`);
  await c4.waitFor(f => f.tab === histId && f.t === "turn_done", 180_000, "history turn_done");
  await c4.close();

  const closed = await api("DELETE", `/tabs/${histId}`);
  assert(closed.status === 200, "DELETE /tabs/:id (close) -> 200");

  const goneFromOpen = await api("GET", `/tabs/${histId}`);
  assert(goneFromOpen.status === 404, `GET /tabs/:id 404s once closed (got ${goneFromOpen.status})`);
  assert(
    !(await api("GET", "/tabs")).json.tabs.some(t => t.id === histId),
    "GET /tabs (open index) no longer lists the closed tab",
  );

  const conversations = await api("GET", "/conversations");
  assert(conversations.status === 200 && Array.isArray(conversations.json.conversations), "GET /conversations -> 200");
  const histRow = conversations.json.conversations.find(c => c.id === histId);
  assert(!!histRow, "GET /conversations still lists the closed tab");
  assert(histRow && histRow.messageCount === 2, `GET /conversations reports the right message count (${histRow?.messageCount})`);

  const reopened = await api("POST", `/tabs/${histId}/reopen`);
  assert(reopened.status === 200, `POST /tabs/:id/reopen -> 200 (got ${reopened.status} ${JSON.stringify(reopened.json)})`);
  assert((reopened.json.messages ?? []).length === 2, "reopen returns the full persisted conversation");
  assert(
    /PONG/i.test((reopened.json.messages ?? []).map(m => m.content).join(" ")),
    `reopened conversation content is intact (${JSON.stringify((reopened.json.messages ?? []).map(m => m.content))})`,
  );
  assert(
    (await api("GET", "/tabs")).json.tabs.some(t => t.id === histId),
    "reopen puts the tab back in the OPEN index",
  );

  const reopenAgain = await api("POST", `/tabs/${histId}/reopen`);
  assert(reopenAgain.status === 200, `reopening an already-open tab is idempotent (got ${reopenAgain.status})`);

  const reopenMissing = await api("POST", "/tabs/ios-smoke-never-existed-0000/reopen");
  assert(reopenMissing.status === 404, `reopening an id with no persisted conversation -> 404 (got ${reopenMissing.status})`);

  await api("DELETE", `/tabs/${histId}`);

  /* --- 9. regression: GET /wait?since=0 answers instantly for an
     already-finished turn ---
     `since - 1` underflows to -1 when a client's cursor is 0 (a brand-new
     tab, or one it has never heard a frame from), which used to make
     ReplayRing.since() short-circuit to `evicted:true` with zero frames
     regardless of what the ring actually held. That silently defeated the
     "answer immediately if it already happened" fast path for exactly the
     case a phone's background wait hits: reconnecting right as a first-ever
     turn finishes. Proven here by timing it — the bug made this take the
     full timeout instead of returning in milliseconds. */
  log("regression: GET /wait?since=0 fast path");
  const waitTab = await api("POST", "/tabs", { title: "smoke-wait", model: "haiku", permissionMode: "acceptEdits" });
  assert(waitTab.status === 200 && waitTab.json.id, `POST /tabs (wait) -> ${JSON.stringify(waitTab.json)}`);
  const waitId = waitTab.json.id;
  testTabIds.push(waitId);

  const c5 = await connect();
  const waitTurn = await api("POST", `/tabs/${waitId}/turn`, {
    blocks: [{ type: "text", text: "Reply with exactly the word PONG." }],
    clientTurnId: "smoke-wait-1",
  });
  assert(waitTurn.status === 202, `POST wait-test turn -> 202 (got ${waitTurn.status})`);
  await c5.waitFor(f => f.tab === waitId && f.t === "turn_done", 180_000, "wait-test turn_done");
  await c5.close();
  /* The turn_done frame has ALREADY happened by now — this /wait call is
     simulating exactly the race the fix targets: a client asking about a
     tab whose only event so far already landed before it asked. */
  const waitStart = Date.now();
  const waited = await fetch(`${BASE}/wait?tab=${waitId}&since=0&timeout=10`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).then(async r => ({ status: r.status, json: JSON.parse(await r.text()) }));
  const waitElapsedMs = Date.now() - waitStart;
  assert(waited.status === 200 && waited.json.frame?.t === "turn_done", `wait since=0 returns the already-finished turn_done (${JSON.stringify(waited.json).slice(0, 150)})`);
  assert(waitElapsedMs < 3000, `wait since=0 answers fast, not after the timeout (${waitElapsedMs}ms)`);

  await api("DELETE", `/tabs/${waitId}`);

  /* --- 10. regression: subscribe naming an unknown tab gets `resync
     {reason:"gone"}` ---
     A tab id the client is tracking (its `since` map) but the registry has
     NEVER heard of — deleted from another device while this client was
     disconnected is the realistic case — used to produce total silence for
     that tab: `evicted` only fires for a tab whose ENGINE still exists.
     Without this signal a client mid-turn on a tab deleted elsewhere would
     wait forever with a locked composer and no error. */
  log("regression: subscribe -> resync{reason:\"gone\"} for an unknown tab id");
  const c6 = await connect();
  const bogusId = "ios-smoke-gone-0000";
  const goneSub = new Promise(resolve => {
    const onFrame = f => {
      if (f.t === "resync" && f.tab === bogusId) resolve(f);
    };
    c6.listeners.add(onFrame);
  });
  c6.ws.send(JSON.stringify({ t: "subscribe", tabs: "all", since: { [bogusId]: 42 } }));
  const goneFrame = await Promise.race([
    goneSub,
    new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
  ]);
  assert(!!goneFrame, "server sends resync for a tab id the registry has never heard of");
  assert(goneFrame?.payload?.reason === "gone", `resync reason is "gone" (${goneFrame?.payload?.reason})`);
  assert(goneFrame?.seq === 0, `gone resync carries seq 0, no cursor to advance to (${goneFrame?.seq})`);
  await c6.close();

  purgeConversationFiles(health.json.cwd, testTabIds);

  console.log("");
  console.log(failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures} assertion${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(`\nSMOKE ERRORED: ${err.stack ?? err.message}`);
  process.exit(1);
});
