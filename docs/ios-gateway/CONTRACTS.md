# Vault Gateway iOS: shared contracts

Authoritative for every agent building the iOS host. Full rationale lives in the vault note
`Claude Config/References/Claude CLI Chat Plugin/Vault Gateway iOS App Plan.md`.
If you must deviate, update this file in the same change.

## Directory ownership (parallel work, no overlap)

| Path | Owner | Notes |
|---|---|---|
| `src/`, `app/src/`, `esbuild.config.mjs`, `tsconfig*.json` | **shared-ui** agent | Node-decoupling. Adds the `--ios` esbuild target emitting to `ios/Web/`. |
| `scripts/gateway/` | **gateway** agent | Node/TS daemon. Own build script `scripts/gateway/build.mjs` (do NOT edit `esbuild.config.mjs`). Imports `src/claude/*`, `src/storage/*`, `src/permissions/*`, `src/mcp/*` read-only. |
| `ios/` except `ios/Web/` | **ios-shell** agent | XcodeGen `project.yml` is authoritative. `ios/Web/` is build output (gitignored) written by the `--ios` esbuild target. |
| `ios-web/` | **remote-engine** agent (wave 2) | Browser entry (`renderer.ts`, `shell.ts`, `index.html`, `ios.css`) and `src/platform/remote/*`. |

Git: all work on `main`, commit per agent with a clear scope prefix (`shared-ui:`, `gateway:`, `ios:`, `ios-web:`). Do not rebase or force-push. Run `npm run typecheck && npm run build && npm run build:app` before any commit that touches `src/` or `app/`.

## Gateway daemon

- Port **8788**, binds the Tailscale IPv4 only (reuse the ifconfig 100.64/10 fallback from `scripts/watch-bridge/bridge.py` `resolve_bind()`), or `127.0.0.1` when `VAULT_GATEWAY_BIND=127.0.0.1` (for `tailscale serve`). Never `0.0.0.0`.
- Env: `VAULT_GATEWAY_VAULT` (cwd, required), `VAULT_GATEWAY_PORT` (8788), `VAULT_GATEWAY_BIND`, `VAULT_GATEWAY_TOKEN_FILE` (default `~/.config/vault-gateway/token`, mode 600, auto-generated 48 hex on first run).
- Auth: `Authorization: Bearer <token>` on every HTTP request, constant-time compare. WebSocket: `POST /ws-ticket` (Bearer) → `{ticket, expiresIn:60}`; connect to `/ws/<ticket>` (ticket in the PATH, not the query string). Single use.
- Tab store: `<vault>/.claude-cli-chat/ios/` via `new Persistence(null, ".claude-cli-chat/ios")`. Event replay ring spilled to `<vault>/.claude-cli-chat/ios/events/<tabId>.ndjson`.
- Spawn flags: everything `SubprocessManager` already passes, plus `--session-id <uuid>` (generated server-side at tab creation; no transcript discovery) and `--replay-user-messages`. Default `permissionMode: "acceptEdits"` for phone tabs; never `bypassPermissions`. `--session-id` and `--resume` are mutually exclusive at the CLI, so the FIRST spawn of a tab passes `--session-id` and every later one passes `--resume`. Both extra flags reach `TabSession` through `SpawnOptions.extraArgs`, a field this work added to `src/claude/SubprocessManager.ts` — optional, appended just before `--resume`, and absent for every existing caller, so plugin and desktop spawns are byte-for-byte unchanged.
- Concurrency: max 4 live children (`VAULT_GATEWAY_MAX_CHILDREN`), LRU-evict idle tabs (dispose, keep sessionId, respawn with `--resume` on next turn). Never evict a busy tab or one with a pending approval.
- Approval deadline: `VAULT_GATEWAY_APPROVAL_TIMEOUT_S` (default 600). On expiry: deny with message "Client unreachable; denied by gateway timeout", emit `approval_resolved{by:"timeout"}`.
- State mirror: write `/tmp/claude_state.ios` in the same `"<epoch> <state>\n"` format as `StateEmitter`. Do NOT write `/tmp/claude_state` or `~/.claude/settings.json`.
- launchd: `scripts/gateway/dev.claude-cli-chat.vault-gateway.plist`, label `dev.claude-cli-chat.vault-gateway`, absolute node path (`/usr/local/bin/node` on this machine — there is no `/opt/homebrew/bin/node`), logs `/tmp/vault-gateway.log` / `.err`.
- Verified through `tailscale serve --bg --http=8790 http://127.0.0.1:8788`: the WebSocket upgrade passes through intact, so the SSE fallback is not needed. Serve routes on the `Host` header — the MagicDNS name works, the raw `100.x` IP 404s.
- ~~WebSocket client caveat: Node 24.14's built-in `WebSocket` (undici) fails EVERY plaintext `ws://` handshake on this machine…~~ **Retracted (wave 2).** The daemon was wrong, not the client. `src/ws.ts` computed `Sec-WebSocket-Accept` from a mistyped RFC 6455 GUID (`…95CA-5AB0DC85B11F` instead of `…95CA-C5AB0DC85B11`), and `test/ws-client.mjs` carried the same typo — so the two agreed with each other and the smoke test passed while every real browser, Chrome and WKWebView alike, rejected the handshake with "Incorrect 'Sec-WebSocket-Accept' header value". `curl -i` cannot catch this: it shows the header, it does not verify the hash. Both constants are corrected and now carry the RFC's own vector (`dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`) so a future typo is checkable in one line. The hand-rolled `ws-client.mjs` stays — it mirrors `src/ws.ts` framing, which is worth having in the smoke test — but node's global `WebSocket` is no longer known-bad against this daemon.
- Known open bug (wave 1, unfixed): a tab created by `POST /tabs` but never given a turn before the daemon restarts is rehydrated with `sessionEstablished` true, so its first spawn passes `--resume <uuid>` for a conversation that does not exist. The CLI exits 1 (`No conversation found with session ID`) and the turn surfaces as `error_during_execution`. Fix belongs in `src/engine.ts`: persist `sessionEstablished`, or fall back to `--session-id` when a resume fails.

### HTTP (all JSON, all Bearer)

| Method | Path | Body → Response |
|---|---|---|
| GET | `/health` | `{state:"starting"\|"ready", version, cwd, uptime_s, liveChildren, maxChildren, tabs:[{id,status,busy,sessionId,model,effort,permissionMode,pid,lastSeq}]}` (no auth required for `/health`? NO: auth required; return 401 otherwise). `starting` until the token is loaded and the vault store has been read; on a cold iCloud vault under launchd that has been measured at ~33 s, so the client must treat `starting` as "wait", not "down". |
| GET | `/catalog` | `{skills, commands, subagents, models:[{key,id,label,efforts,group}], efforts:[...], permissionModes:[{key,label}], mcpServers:[{name,enabled,status}], userName, hash}` — `hash` is the `catalogHash` the `hello` frame carries. `permissionModes` omits `bypassPermissions` entirely (a phone tab may never run in it). 5-minute server cache; `?refresh=1` forces a rescan. |
| GET | `/tabs` | `TabIndex` (`src/storage/Persistence.ts` shape: `{activeTabId, tabs:[{id,title,sessionId}]}`) |
| POST | `/tabs` | `{title?, model?, effort?, permissionMode?, incognito?}` → `{id, sessionId}` (no spawn) |
| GET | `/tabs/:id` | `StoredTab`, plus the live `{busy, status, lastSeq}` so a cold client can render and resume from one call |
| PATCH | `/tabs/:id` | `{title?, model?, effort?, permissionMode?, pinnedFilePaths?, active?:true}` → `{ok}`; engine-affecting changes take effect via respawn `--resume` on next turn |
| DELETE | `/tabs/:id` | → `{ok}` |
| POST | `/tabs/:id/turn` | `{blocks: ContentBlock[], clientTurnId}` → 202 `{turnId, seq}`; 409 `{error:"busy"}`; 503 `{error:"no_capacity"}` when the child budget is full and every live tab is busy or holding an approval (nothing is evictable). `blocks` also accepts a bare string, or an array of strings, as shorthand for one text block. |
| POST | `/tabs/:id/abort` | → `{ok}` |
| POST | `/tabs/:id/approve` | `{request_id, allowed, reason?, updatedInput?}` → `{ok}` |
| POST | `/tabs/:id/title` | → `{title}` |
| GET | `/tabs/:id/events?since=N&limit=M` | `{events:[Frame], lastSeq, evicted:boolean}` |
| GET | `/wait?tab=ID&since=SEQ&timeout=S` | long-poll; 200 `{frame, lastSeq}` with the first `turn_done` or `approval_request` frame at `seq>=since`; 202 `{partial:true, error:"wait_timeout", lastSeq}`. `timeout` is clamped to 300 s |
| GET / POST | `/permissions`, `/permissions/allow` | `{allow:[...], recommended:[...]}` / `{patterns:[...]}` → `{ok, added}` |
| GET | `/files?q=&limit=` | `{files:[{path, name, mtime}]}` (markdown + common attachments under the vault, excluding dot-dirs). Empty `q` returns most-recently-modified. 30 s index cache |
| GET | `/file?path=` | `{path, text}` (text files only, 512 KB cap). 400 `path_outside_vault`, 403 `dot_path_excluded` (same dot-dir rule as `/files`), 413 `file_too_large`, 415 `not_a_text_file` |
| GET | `/usage` | port of bridge.py `UsageFetcher` payload (same JSON), 60 s cache |
| POST | `/mcp/disable` | `{servers:[...]}` → `{ok, disabled:[...]}`. The list is absolute: names absent from it are re-enabled. Invalidates the `/catalog` cache |
| POST | `/ws-ticket` | → `{ticket, expiresIn}` |

Errors: `{error:"<snake_case>", message?}` with proper status (400/401/404/409/500).

### WebSocket `/ws/<ticket>`

Server → client frame: `{"v":1,"seq":<int per tab, monotonic from 1>,"tab":"<id>"|null,"t":"<type>","payload":{...}}`

| `t` | payload |
|---|---|
| `hello` | `{serverStartedAt, tabs:[{id,lastSeq,status}], catalogHash}` (tab=null, seq=0) |
| `event` | raw stream-json `StreamEvent` exactly as `StreamJsonParser` yielded it |
| `tab_status` | `{status:"idle"\|"starting"\|"ready"\|"running"\|"exited"\|"error", sessionId, pid, model, effort, permissionMode, exitCode?, stderrTail?}` |
| `approval_request` | the `control_request` request object plus `request_id` |
| `approval_resolved` | `{request_id, allowed, by:"client"\|"timeout"\|"restart"\|"cancel"}` |
| `turn_done` | `{turnId, subtype, durationMs, usage?, costUsd?}` |
| `catalog` | full `/catalog` payload |
| `resync` | `{reason:"buffer_evicted"}` (client must GET `/tabs/:id` then subscribe with `since: lastSeq`) |
| `pong` | `{}` |
| `error` | `{error, message?}` — a client→server message the server could not act on (`bad_json`, `unknown_message`, `no_such_tab`, `empty_turn`, `busy`, `no_capacity`). Carries `seq: 0`; `tab` is set when the message named one |

Client → server: `{"t":..., ...}`

| `t` | fields |
|---|---|
| `subscribe` | `{tabs:"all"\|[ids], since:{[tabId]:seq}}` — server replays frames with `seq > since` then streams live |
| `turn` | `{tab, blocks, clientTurnId}` |
| `approve` | `{tab, request_id, allowed, reason?, updatedInput?}` |
| `abort` | `{tab}` |
| `patch` | `{tab, model?, effort?, permissionMode?}` |
| `ping` | `{}` |

## JS ↔ native bridge (WKWebView)

Page is loaded from `vaultgw://app/index.html` (custom `WKURLSchemeHandler` serving the `ios/Web/` folder reference; correct MIME types; `renderer.js` loaded with `defer`).

Native injects nothing into the page except the message handler. The page calls:

```ts
// request/response via WKScriptMessageHandlerWithReply, name "native"
window.webkit.messageHandlers.native.postMessage({ method, params }) : Promise<any>
```

Methods (native implements; page wraps in `ios-web/src/native.ts`):

| method | params | returns |
|---|---|---|
| `getConfig` | | `{host, scheme:"http"\|"https", port, vaultName, hasToken, appVersion, theme:"dark"\|"light", safeArea:{top,bottom,left,right}}` |
| `rpc` | `{method, path, body?}` | `{status, json}` — native adds Bearer from Keychain, 15 s timeout; network errors → `{status:0, error:"cannot_find_host"\|"timed_out"\|"refused"\|"other", message}` |
| `wsUrl` | | `{url}` — native calls `POST /ws-ticket` and returns `ws(s)://host:port/ws/<ticket>` |
| `haptic` | `{kind:"light"\|"medium"\|"success"\|"warning"\|"error"\|"selection"}` | `{ok}` |
| `openSettings` | | `{ok}` |
| `setState` | `{activeTabId, lastSeq:{[tabId]:seq}, busyTabs:[ids]}` | `{ok}` — native persists for background `/wait` arming |
| `speak` | `{text}` / `{stop:true}` | `{ok}` (AVSpeechSynthesizer) |
| `copy` | `{text}` | `{ok}` |

Native → page (native calls `window.__vaultgw.dispatch(name, payload)` via `evaluateJavaScript`; the page defines `__vaultgw` before anything else):

| name | payload |
|---|---|
| `suspend` | `{}` — page must close its WebSocket and call `setState` synchronously-ish before returning |
| `resume` | `{}` — page reconnects with `subscribe since` |
| `connectivity` | `{state:"ok"\|"tailscale_off"\|"mac_asleep"\|"gateway_down"\|"unauthorized"\|"starting", message}` |
| `theme` | `{theme}` |
| `safeArea` | `{top,bottom,left,right}` |
| `share` | `{text}` — insert into the active composer |

The native connectivity banner is a native view; the page may also show an inline state but must not be the only indicator.

## Visual direction (ios-web, wave 2)

Match Claude Quick Chat (`app/desktop.css`, GitHub-dark palette, `--claudian-brand` orange asterisk) with glass: translucent header and composer card over a dark gradient (`backdrop-filter: blur(24px) saturate(160%)`, 1px hairline borders at 12% white, subtle inner highlight). Header: asterisk + "Claude", right side ONLY new tab, new chat, MCP, history, settings. Drop Remote Control and Center window. Welcome screen: asterisk + "Welcome back, <userName>" in the same serif. Composer: mode chip, incognito, voice; model pill right; bottom row effort, MCP count, agents, +, send. Dark only for v1. Safe areas, `visualViewport` keyboard inset, 44pt touch targets, `@media (hover: hover)` guard.

## PluginHost capabilities (added by shared-ui)

The shared view layer (`src/view/*`, `src/storage/*`, `src/mcp/*`, `src/platform/*`) now builds as a pure-browser bundle: no `node:*`, `electron`, or `obsidian` import reaches it. Everything that used to reach the machine directly goes through `PluginHost` (`src/platform/host.ts`). A host implements what it can; shared code calls every optional member through `?.` and has a defined fallback, so an absent capability degrades a feature instead of breaking the build.

**Engine handle.** `PluginHost.subprocessManager` is now typed `SubprocessManagerLike` (`src/platform/engine.ts`), not the concrete `SubprocessManager`. The property name is unchanged. `engine.ts` also defines `TabSessionLike` and `RemoteControlSessionLike`, and type-only re-exports `SpawnOptions`, `TabSessionStatus`, `StreamEvent`, `ContentBlock`, `ControlRequestEvent`, `RemoteStatus` so browser code has one node-free import site for the engine vocabulary. `SubprocessManager` / `TabSession` / `RemoteControlSession` satisfy these structurally; nothing changed on the desktop.

```ts
interface SubprocessManagerLike {
  spawn(tabId: string, opts: SpawnOptions): TabSessionLike;
  registerRemote(tabId: string, session: RemoteControlSessionLike): void;
  unregisterRemote(tabId: string): void;
  claimSessionFile(path: string): boolean;
  isSessionFileClaimed(path: string): boolean;
}

interface TabSessionLike {
  sessionId: string | null;
  status: TabSessionStatus;               // starting | ready | running | exited | error
  readonly pid: number | undefined;
  sendUserText(text: string): void;
  sendUserContent(blocks: ContentBlock[]): void;
  approve(requestId: string, updatedInput?: Record<string, unknown>): void;
  deny(requestId: string, reason?: string): void;
  getPendingApprovals(): ControlRequestEvent[];
  isTerminal(): boolean;
  dispose(): Promise<void>;
  onEvent(cb: (e: StreamEvent) => void): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(cb: (err: Error) => void): void;
  onStderr(cb: (chunk: string) => void): void;
}
```

**Optional node-backed hooks.** All optional; the remote engine implements the ones the phone can honor over the gateway and omits the rest.

| Member | Signature | Absent ⇒ |
|---|---|---|
| `stateEmitter` | `{ setState(state: DisplayState): void }` | no TC001 state emitted |
| `removeSessionFiles` | `(cwd: string, sessionIds: string[]) => Promise<void>` | incognito teardown deletes nothing locally (the gateway owns that disk) |
| `createJsonlTailer` | `(path: string) => JsonlTailerHandle` — `{ onEvent(cb), onError(cb), start(): Promise<void>, stop(): Promise<void> }` | Remote Control surfaces no conversation events |
| `createSubagentTracker` | `(opts: { cwd, parentSessionId, parentToolUseId, parentPrompt, onUpdate }) => { start(): void; stop(): void }` | tool rows show no nested subagent events |
| `generateTitle` | `(opts: TitleGenOptions) => Promise<string \| null>` | tab keeps its placeholder title |
| `createRemoteControlSession` | `(opts: { cwd, sessionName?, claudePath? }) => RemoteControlSessionLike` | Remote Control toggle notifies and stays off |
| `createSubagentFile` | `(opts: { scope: "user" \| "project", name, contents }) => { ok: true } \| { ok: false, kind: "no_vault" \| "exists" \| "write_failed", message? }` | create-subagent form notifies and cannot save |
| `openPathExternally` | `(path: string, mode: "open" \| "reveal") => void` (may throw) | open / reveal buttons no-op |

Node implementations of all of these live in `src/platform/node-capabilities.ts` and are wired identically into `ClaudeChatPlugin` (`src/main.ts`) and `DesktopHost` (`app/src/host.ts`). **Only those two files may import that module.**

**Other seams the remote host must know about**

- `Persistence` no longer imports node. `flushSync()` (the quit-time last-write-wins pass) needs a synchronous file API injected via `setSyncFileWriter({ mkdirSync, renameSync, writeFileSync })`, exported from `src/storage/Persistence.ts`. Both node hosts call it at boot; a `globalThis.require("fs")` probe is the fallback. Any other node embedder (e.g. `scripts/gateway/`) that depends on `flushSync()` must call it too — the async debounced saves are unaffected either way.
- `spawnOptionsFromSettings` moved to `src/claude/spawn-options.ts` (pure). `SubprocessManager` re-exports it, so existing imports are unchanged.
- `autodetectClaudePath` / `autodetectUserName` moved to `src/settings-autodetect.ts` so `src/settings-data.ts` is node-free. `src/settings.ts` re-exports both, so `../settings` imports are unchanged.
- Browser-safe DOM helpers moved out of `app/src/` into `src/platform/dom/`: `dom-polyfill.ts` (`installDomHelpers`), `desktop-icons.ts` (`renderIcon`), `desktop-overlays.ts` (toast / context menu / modal hosts), `snippet-picker.ts` (`DesktopSnippetPicker`), and the new `markdown.ts` (`renderMarkdownInto`, `sanitizeFragment`, extracted from `app/src/desktop-platform.ts`). Exports are unchanged; the iOS platform should build on these.

**Build target.** `npm run build:ios` (`node esbuild.config.mjs --ios`, plus `build:ios:prod` and `dev:ios`) bundles `ios-web/src/renderer.ts` as `platform: "browser"`, `format: "iife"` into `ios/Web/` and copies `ios-web/index.html`, `styles.css`, `app/desktop.css` and `ios-web/ios.css` beside it. `ios/Web/` is gitignored. A `forbid-node` esbuild plugin (mirroring `forbid-obsidian`) fails the build, naming the importer, on any `(node:)?(fs|fs/promises|child_process|path|os|http|https|net|readline|stream|zlib|url|crypto|util|events)`, `electron`, or `obsidian` import. ~~`ios-web/src/renderer.ts` is a PLACEHOLDER…~~ replaced in wave 2 by the real client; see [`WAVE2.md`](WAVE2.md) for the remote seam, the storage mapping and what is disabled on iOS. `ios-web/tsconfig.json` (`"types": []`) is part of `npm run typecheck`.

**Known remaining `node:`/`obsidian` imports under `src/view` and `src/mcp`** (none reach the browser bundle — the `forbid-node` guard is the authoritative check):

- `src/view/ClaudeChatView.ts`, `ActiveFileIndicator.ts`, `SelectionTracker.ts`, `SnippetPicker.ts` — classified Obsidian-only in `src/platform/MIGRATION.md` and never imported by shared code. `ClaudeChatView` also reads `process.pid` / `process.kill` for the multi-window lock; left as-is deliberately, since it is an `ItemView` that can only ever run inside Obsidian.
- `src/mcp/McpServerList.ts` — shells out to `claude mcp list`. Shared code (`MCPManagerModal`, `PluginHost`) only ever `import type { ParsedMcpServer }` from it; the value import lives in the two node hosts.
