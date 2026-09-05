# claude-cli-chat

Monorepo for a family of Claude chat clients over one shared TypeScript UI core. The original product is an Obsidian plugin that wraps the Claude Code CLI (`claude --print --output-format stream-json --input-format stream-json`) as a chat UI — each chat tab spawns its own CLI subprocess and renders the event stream as bubbles, tool rows, and diffs. macOS only (Remote Control mode depends on Python `pty.fork`).

Top-level structure (since the 2026-08-31 restructure):

- `src/`: the shared core — view layer, CLI/event plumbing, storage, platform abstraction. Every app bundles from here; `src/main.ts` is specifically the Obsidian plugin entry.
- `apps/obsidian/`: the plugin's `manifest.json` + `styles.css` (entry lives in `src/main.ts`; build ships all three to the vault).
- `apps/electron/`: "Claude Quick Chat" — standalone Electron menu-bar shell.
- `apps/ios/`: "Claude & Second Brain" — Swift/WKWebView shell for iPhone + iPad (XcodeGen project).
- `apps/ios-web/`: the browser client the iOS shell hosts (also runnable in a desktop browser via its dev server).
- `daemons/gateway/`: Vault Gateway — the Mac-side node daemon the iOS app talks to (launchd: `dev.claude-cli-chat.vault-gateway`).
- `daemons/watch-bridge/`: Apple Watch chat bridge daemon (launchd: `dev.claude-cli-chat.watch-bridge`). The watchOS client itself is the separate `ask-claude-watch` repo.
- `scripts/`: out-of-tree helpers (TC001 animator + its plist, smoke tests, credit-pool forecaster). Not bundled.

The user-level launchd plists in `~/Library/LaunchAgents/dev.claude-cli-chat.*.plist` point at absolute paths inside this repo — moving a daemon's folder means updating its plist and kickstarting the job.

## Commands

- `npm run dev`: watch-mode esbuild
- `npm run build`: one-shot build, writes directly to the vault plugin folder
- `npm run typecheck`: `tsc --noEmit`

Build output path: `/Users/henryortega/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain/.obsidian/plugins/claude-cli-chat/main.js`. After building, reload the plugin in Obsidian (Settings → Community plugins → toggle off/on, or Cmd+P → "Reload app without saving") to pick up changes.

## Layout

- `src/main.ts`: plugin entry, registers the chat view, holds plugin-wide singletons (settings, SubprocessManager).
- `src/settings.ts`: settings tab UI and persisted shape.
- `src/claude/`: everything that talks to the CLI.
  - `SubprocessManager.ts`: spawn, kill, track child processes.
  - `StreamJsonParser.ts`: line-delimited JSON parsing.
  - `Events.ts`: typed events the parser yields.
  - `InputWriter.ts`: stream-json writes back to CLI stdin.
  - `RemoteControlSession.ts`: pty-proxied `claude --remote` flow (inline Python `pty.fork()`).
  - `JsonlTailer.ts`: follows `~/.claude/projects/.../session.jsonl` for resume support.
  - `SkillDiscovery.ts`: scans disk for skills + slash commands at plugin load.
  - `QuickPrompt.ts`: shared one-shot `claude --print` side-pass spawner (Haiku, tools off, no session persistence).
  - `TitleGenerator.ts`: auto-titles new tabs (via QuickPrompt).
  - `ReplySuggester.ts`: proposes the user's next message after each turn; surfaces as Tab-to-accept ghost text in `InputBox` (via QuickPrompt).
- `src/view/`: Obsidian view and DOM.
  - `ClaudeChatView.ts`: the `ItemView` shell.
  - `TabController.ts`: the heart of the plugin. Owns tab state, routes CLI events into `ChatMessage` entries, handles all submit / cancel / approval / tool-result orchestration. ~1.4k lines; grep before adding a new method.
  - `MessageRenderer.ts`: bubble / tool / diff DOM, scroll stickiness, thinking section, todo lists, subagent summaries.
  - `state.ts`: `ChatMessage`, `TabState`, `ToolCall`, `Attachment`, `SelectionContext` shapes.
  - Focused UI surfaces: `Header.ts`, `InputBox.ts`, `TabBar.ts`, `Welcome.ts`, `StatusIndicator.ts`, `ActiveFileIndicator.ts`, `SearchBar.ts`, `SnippetPicker.ts`, `HistoryModal.ts`, `RemotePairingCard.ts`, `MCPManagerModal.ts`, `ApprovalModal.ts`, `SelectionTracker.ts`, `DiffRenderer.ts`.
- `src/voice/SpeechController.ts`: voice mode (TTS). Speaks streaming assistant text + whole notes via macOS `say` child processes — NOT window.speechSynthesis (Electron's cancel() can't reach the macOS speech daemon; see the file header and the vault note `Voice Mode`). Channel-scoped: streams/queue chunks are tagged with an owner (tab id or document), `stop(channel)` silences only that owner, first enqueuer holds the floor. Stream offsets are monotonic and survive stop() so interrupted replies never re-narrate. Sentence-boundary chunker skips fenced code (fences open only at true line starts); `sanitizeForSpeech` strips markdown per chunk.
- `src/storage/Persistence.ts`: tab state save/load at `<vault>/.claude-cli-chat/`. Debounced.
- `src/mcp/MCPConfig.ts`: reads/writes `<vault>/.claude/mcp.json`. The CLI ignores this file, so it is NOT a server source — it only persists the per-vault disable list (`disabledServers: string[]`). Also exports `sanitizeMcpServerName` / `mcpDenyPattern` (display name → `mcp__<sanitized>` rule). The legacy `mcpServers`/`disabledMcpServers` maps are round-tripped but no longer drive anything.
- `src/mcp/McpServerList.ts`: `listMcpServersViaCli` + `parseMcpListOutput` — shells out to `claude mcp list` for the authoritative set of servers the spawned chat actually loads (incl. claude.ai account connectors).
- Per-vault MCP disable: the MCP manager lists the real CLI servers; unchecking one records its name in `disabledServers`. At spawn, those become `mcp__<server>` deny rules passed via `--settings` (SubprocessManager.buildArgs), which removes the server's tools from the model's tool list. Scoped to the plugin's subprocesses only — other Claude Code instances and the server definitions are untouched. Patterns are cached on the plugin (`mcpDenyPatterns`, refreshed via `refreshMcpDenyPatterns`) so the synchronous spawn path can read them.
- `src/permissions/PermissionsConfig.ts`: `can_use_tool` policy.
- `scripts/`: out-of-tree shell + Python helpers (TC001 animator, smoke tests, credit-pool forecaster). Not bundled.
- `daemons/watch-bridge/`: Apple Watch chat bridge — launchd daemon (`bridge.py`) holding one interactive `claude` session (no `--print`, subscription-cap billing) in a PTY over the vault, HTTP API for a watch Shortcut via Tailscale; `stop_hook.py` signals end-of-turn. Authoritative doc note lives in the vault.

## Wire-format gotchas (do not regress)

Each of these was a load-bearing bug we hit and fixed. Authoritative reference is the vault note `Wire Format Gotchas`; quick version:

1. stream-json mode emits no `system/init` event until it reads the first stdin user message. Send the user message immediately after spawn or both sides deadlock.
2. `tool_use` blocks live INSIDE the assistant message's `content[]` array, not as top-level `tool_use` events. Filtering `content` to text-only drops tools silently.
3. `tool_result` blocks live INSIDE synthetic `user`-type events (`event.type === "user"`, content blocks with `type: "tool_result"`). Missing this leaves tools stuck on "RUNNING" forever.
4. The `can_use_tool` control_response schema is `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`. Any other shape produces a Zod parse error that the CLI returns as a synthetic tool_result, which the model then narrates as "harness ZodError".
5. Model `[1m]` suffix gating: Opus 1M, Fable 5 1M, and Sonnet 5 1M support `xhigh` effort (CLI-verified for Sonnet 5 on 2026-07-08); other models top out at `max`.
6. Synthetic `user` events usually carry `message.content` as a block array, but some — notably the `<task-notification>` wake-ups for finished background agents — carry it as a PLAIN STRING. Iterating a string as blocks walks its characters silently, so the notification never parses and agent cards stay on Running forever. Normalize string content to one text block first (`handleUserEcho`).
7. `--no-session-persistence` (incognito) suppresses the conversation transcript but the CLI STILL writes a one-line `ai-title` record to `~/.claude/projects/<slug>/<session-id>.jsonl`, and that title summarizes the chat. Neither `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` nor any flag stops it. Incognito tabs therefore delete their own session files on teardown (`TabController.cleanupIncognitoSessionFiles`) rather than trusting the flag alone.

## Authoritative deeper docs

Detailed docs live in the vault rather than this repo: `Claude Config/References/Claude CLI Chat Plugin/` (folder note + sub-notes). Key sub-notes:

- `Wire Format Gotchas`: the "do not regress" reference.
- `Subprocess and Streaming`: process lifecycle and parser.
- `UI - Message Rendering`: bubble / tool / diff rendering.
- `UI - Composer and Status`: input box, model picker, effort chip, mode chip.
- `Decision Log`: why X over Y for past architectural choices.
- `Change Log`: iteration history. Add a session entry here when making non-trivial changes.
- `Known Limitations`.
- `2026-06-15 Agent SDK Credit Pool`: billing context for the upcoming credit-pool shift.

## Conventions

- TypeScript strict. Avoid `any`; reach for `unknown` + narrowing first.
- Build DOM with Obsidian's `createDiv` / `createSpan` helpers so theme classes apply.
- Streaming renders go through `MessageRenderer.upsertMessage`, which serializes per-message via a render chain. Don't mutate `liveEls` from outside the renderer.
- Persistence is debounced. After mutating `state.messages` or any persisted field, call `onStateChangeCb()` so the debounce fires.
- Incognito tabs (`TabState.incognito`, runtime-only) must touch no disk. The flag gates `scheduleSaveTab`, is filtered out of `saveIndex`, skips `deleteTab`, spawns with `--no-session-persistence`, and triggers session-file cleanup on teardown. If you add a new write path, guard it on `!state.incognito`.
- Tool calls are tracked through `toolToMessage` (tool_use_id → message id). When introducing a new tool path, register the mapping at `content_block_start` time.
- macOS only. Don't add code paths that assume Linux/Windows process behavior.

## Bundling

Single-file esbuild via `esbuild.config.mjs`. Output is the plugin's `main.js` directly inside the vault's `.obsidian/plugins/claude-cli-chat/` folder (no intermediate `dist/`). `manifest.json` and `styles.css` are committed at the repo root and shipped alongside `main.js` by the build script.
