# Vault Gateway daemon

The Mac-side backend for the Vault Gateway iOS app. It holds the `claude` child
processes, owns the tab store, and exposes them over an authenticated HTTP +
WebSocket API on the tailnet. The phone renders; this decides.

Authoritative contract: [`docs/ios-gateway/CONTRACTS.md`](../../docs/ios-gateway/CONTRACTS.md).

## What it is

- **One process, many tabs.** Each tab owns a `claude --print --output-format
  stream-json` child, spawned through the same `SubprocessManager` /
  `TabSession` the Obsidian plugin and the desktop shell use, so wire-format
  behavior cannot drift between the three clients.
- **Session identity up front.** A tab's session UUID is generated at creation
  and passed as `--session-id` on the first spawn; every later spawn resumes it
  with `--resume`. There is no transcript discovery.
- **Bounded child budget.** At most `VAULT_GATEWAY_MAX_CHILDREN` (4) live
  children. When the budget is full, the least-recently-active tab that is
  neither busy nor holding an approval loses its child; the conversation
  survives because the next turn resumes by session id.
- **Replay, not hope.** Every frame gets a per-tab monotonic `seq`, is kept in
  an in-memory ring, and is appended to
  `<vault>/.claude-cli-chat/ios/events/<tabId>.ndjson`. A phone that reconnects
  with `since` gets exactly the frames it missed.
- **Deadlines on approvals.** An approval nobody answers within
  `VAULT_GATEWAY_APPROVAL_TIMEOUT_S` (600) is denied with
  `Client unreachable; denied by gateway timeout`, so a phone that went into a
  tunnel can't wedge a turn forever.

## Build

```sh
node scripts/gateway/build.mjs              # -> scripts/gateway/dist/gateway.js
node scripts/gateway/build.mjs --watch      # rebuild on change
node scripts/gateway/build.mjs --production # minified, no sourcemap
```

Single esbuild bundle, CJS, node builtins external. It deliberately does not go
through the repo's `esbuild.config.mjs` (that file belongs to the plugin and app
builds).

## Run it by hand

```sh
VAULT_GATEWAY_VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain" \
VAULT_GATEWAY_BIND=127.0.0.1 \
VAULT_GATEWAY_PORT=8788 \
node scripts/gateway/dist/gateway.js
```

Without `VAULT_GATEWAY_BIND` it resolves the Tailscale IPv4 (CLI first,
`ifconfig` fallback for launchd sessions, 60 s of retries) and binds only that.
It never binds `0.0.0.0`.

## Enrollment: the bearer token

On first run the daemon generates 48 hex characters at
`~/.config/vault-gateway/token` (mode 600) and prints **once**:

```
VAULT GATEWAY TOKEN: <48 hex chars>
```

Under launchd that line lands in `/tmp/vault-gateway.log`. Copy it into the iOS
app's settings (it goes to the Keychain); the daemon never prints it again.

```sh
cat ~/.config/vault-gateway/token          # read it back any time
```

To rotate: `rm ~/.config/vault-gateway/token`, restart the daemon, re-enroll the
phone. Every HTTP request needs `Authorization: Bearer <token>`, `/health`
included. WebSockets can't carry a header, so the client POSTs `/ws-ticket` and
connects to `/ws/<ticket>` — single use, 60 s, in the path rather than the query
string.

## Install as a launchd agent

```sh
node scripts/gateway/build.mjs
cp scripts/gateway/dev.claude-cli-chat.vault-gateway.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.claude-cli-chat.vault-gateway.plist
```

Verify:

```sh
launchctl print gui/$(id -u)/dev.claude-cli-chat.vault-gateway | head -20
curl -s -H "Authorization: Bearer $(cat ~/.config/vault-gateway/token)" \
     "http://$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4):8788/health"
tail -f /tmp/vault-gateway.log /tmp/vault-gateway.err
```

Reload after a rebuild, and stop:

```sh
launchctl kickstart -k gui/$(id -u)/dev.claude-cli-chat.vault-gateway
launchctl bootout gui/$(id -u)/dev.claude-cli-chat.vault-gateway
```

The plist pins `/usr/local/bin/node` — this machine has no
`/opt/homebrew/bin/node`. Check `which node` before editing it, and keep it
absolute: launchd agents get no login-shell PATH.

The daemon runs on port 8788 and leaves the Apple Watch bridge on 8787 alone.

## Smoke test

```sh
node scripts/gateway/test/smoke.mjs                       # against 127.0.0.1:8788
node scripts/gateway/test/smoke.mjs http://host:8790       # through tailscale serve
```

It drives a real `claude` child: creates a tab, opens a WebSocket, runs a plain
turn, runs a tool turn that requires approval and approves it, disconnects and
reconnects with `since` asserting the replay has no gaps or duplicates, then
checks the persisted tab. `scripts/gateway/test/ws-client.mjs` is a small
hand-rolled WebSocket client — Node 24's built-in one fails every plaintext
`ws://` handshake on this machine, including against a byte-identical copy of a
public server's response it accepts over `wss://`.

## Through `tailscale serve`

WebSocket upgrade passes through cleanly (verified end to end):

```sh
tailscale serve --bg --http=8790 http://127.0.0.1:8788
node scripts/gateway/test/smoke.mjs http://henrys-macbook-pro.tail92466c.ts.net:8790
tailscale serve --http=8790 off
```

Note that serve routes on the `Host` header: the MagicDNS name works, the raw
`100.x` IP returns 404. Run the daemon with `VAULT_GATEWAY_BIND=127.0.0.1` when
fronting it this way.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_GATEWAY_VAULT` | — (**required**) | Working directory for every child; the vault root |
| `VAULT_GATEWAY_PORT` | `8788` | Listen port |
| `VAULT_GATEWAY_BIND` | auto (Tailscale IPv4) | Bind address; `127.0.0.1` for `tailscale serve` |
| `VAULT_GATEWAY_TOKEN_FILE` | `~/.config/vault-gateway/token` | Bearer token path, mode 600 |
| `VAULT_GATEWAY_MAX_CHILDREN` | `4` | Live `claude` children before LRU eviction |
| `VAULT_GATEWAY_APPROVAL_TIMEOUT_S` | `600` | Unanswered approval deadline |
| `VAULT_GATEWAY_CLAUDE` | autodetected | Path to the `claude` binary |
| `VAULT_GATEWAY_STATE_FILE` | `/tmp/claude_state.ios` | TC001 state mirror |
| `VAULT_GATEWAY_PARTIAL` | on | `0` drops `--include-partial-messages` |

## On-disk footprint

| Path | Contents |
|---|---|
| `<vault>/.claude-cli-chat/ios/tabs.json` | Tab index |
| `<vault>/.claude-cli-chat/ios/conversations/<id>.json` | Persisted tabs (plus `.meta.json` sidecars) |
| `<vault>/.claude-cli-chat/ios/events/<id>.ndjson` | Replay spill, rotated past 64 MB |
| `~/.config/vault-gateway/token` | Bearer token, mode 600 |
| `/tmp/claude_state.ios` | TC001 state mirror, `"<epoch> <state>\n"` |
| `/tmp/vault-gateway.log`, `.err` | launchd logs |

The store is namespaced under `ios/`, disjoint from the plugin's
`.claude-cli-chat/` and the desktop app's `.claude-cli-chat/desktop/`, so all
three run at once without contending. The daemon never writes
`/tmp/claude_state` or `~/.claude/settings.json`.

## Layout

| File | Role |
|---|---|
| `src/main.ts` | Boot order, shutdown, signal handling |
| `src/config.ts` | Env parsing; Tailscale bind resolution |
| `src/token.ts` | Token generation and constant-time compare |
| `src/server.ts` | HTTP routes, ticket flow, WebSocket multiplexing |
| `src/ws.ts` | Minimal RFC 6455 server (no dependencies) |
| `src/engine.ts` | `TabEngine`: one tab's child, seq, approvals, projection |
| `src/registry.ts` | Tab store, child budget, LRU |
| `src/replay.ts` | Per-tab ring plus ndjson spill |
| `src/catalog.ts` | `/catalog` assembly |
| `src/files.ts` | Vault search and bounded reads |
| `src/usage.ts` | OAuth usage proxy (port of `bridge.py`'s `UsageFetcher`) |
| `src/state-mirror.ts` | `/tmp/claude_state.ios` writer |
| `src/platform-node.ts` | Node `Platform` so the shared stores have file I/O |
