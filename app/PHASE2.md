# Phase 2 — Standalone Electron shell ("Claude Quick Chat")

Goal: a resident macOS menu-bar app that shows a floating Spotlight-style panel on a
global hotkey, hosting the SAME shared chat code the Obsidian plugin uses (Phase 1
decoupled it; shared code reaches the host only via `src/platform/`). Obsidian is not
involved at runtime.

Read `src/platform/MIGRATION.md` first for the Phase 1 design (Platform interface,
PluginHost seam, classification).

## Non-negotiable invariants

- NOTHING under `src/` may change in this phase, with one exception: if a genuine
  blocker is found in `src/platform/*` (a missing capability), fix it minimally and
  record it in your report. The Obsidian plugin build (`npm run build`) and
  `npm run typecheck` must still pass untouched.
- The app is macOS-only (matches the repo; SubprocessManager and voice assume macOS).
- Billing: the shell spawns the same `claude --print --output-format stream-json`
  subprocesses via the shared SubprocessManager — Agent SDK credit pool, unchanged.
- TypeScript strict, `unknown` + narrowing over `any`, comment style matches the repo
  (block comments explaining invariants, not narration).

## File layout & ownership (one owner per file — do not edit files you don't own)

```
app/
  PHASE2.md              (this spec — read-only)
  index.html             Agent B
  desktop.css            Agent D
  src/
    main.ts              Agent B   (Electron main process)
    dom-polyfill.ts      Agent A
    desktop-platform.ts  Agent A   (+ any private helper modules A creates in app/src/)
    host.ts              Agent C   (DesktopHost implements PluginHost)
    shell.ts             Agent C   (DesktopChatShell — port of ClaudeChatView)
    renderer.ts          Agent C   (renderer entry; + any private helper modules C creates)
  dist/                  build output (gitignored; Agent B adds .gitignore entry)
```

Shared repo files touched: `esbuild.config.mjs`, `package.json` scripts, `tsconfig.json`
— ALL owned by Agent B. Deps are already installed: `electron` (devDep), `marked`,
`lucide`.

## Contracts between agents (must match EXACTLY)

### Agent A exports

```ts
// app/src/dom-polyfill.ts
export function installDomHelpers(): void;   // idempotent
```
Implements Obsidian's DOM prototype augmentations on HTMLElement (and
DocumentFragment where Obsidian has them): `createEl(tag, info?, cb?)` with the full
DomElementInfo shape (`cls` string|string[], `text` string|DocumentFragment, `attr`,
`title`, `parent`, `value`, `type`, `prepend`, `placeholder`, `href`), `createDiv`,
`createSpan`, `empty()`, `setText()`, `addClass(...)`, `removeClass(...)`,
`toggleClass(cls, on)`, `setAttr()`, `detach()`, `onClickEvent()` if used. Shared-code
usage counts (grep to confirm nothing else): createDiv 176, createSpan 118, createEl 64,
setText 34, addClass 28, removeClass 20, empty 20, toggleClass 17, setAttr 6, detach 1.

```ts
// app/src/desktop-platform.ts
export class DesktopPlatform implements Platform {
  constructor(opts: { baseDir: string });    // absolute dir all storage paths resolve against
}
```
- `storage`: node `fs/promises` rooted at `baseDir` (paths are vault-relative strings
  exactly as shared code passes them today, e.g. `.claude-cli-chat/tabs/x.json`).
  `basePath()` returns `baseDir`. `mkdir` recursive. `list()` → `{files, folders}` of
  full relative paths (match Obsidian adapter semantics — check `src/platform/obsidian.ts`).
- `notify(msg, timeoutMs)`: stacked toast, bottom of panel, class `claudesk-toast`,
  auto-dismiss `timeoutMs ?? 4000`.
- `setIcon(el, iconId)`: lucide `icons` map (kebab→Pascal), rendered as inline SVG at
  Obsidian's sizing (svg gets classes `svg-icon lucide lucide-<id>`); special-case
  `"claude-asterisk"` using `CLAUDE_ASTERISK_ICON_SVG` from `src/view/Welcome`
  (inner-SVG content pre-scaled for a 0-100 viewBox). Replace previous icon content.
- `renderMarkdown(md, el, sourcePath, lifecycle?)`: `marked` with `{gfm: true,
  breaks: true}`, append parsed HTML into `el`. Fenced code → `<pre><code>`. Lifecycle
  param is ignored (opaque). No sanitizer (local-only content) — but strip raw
  `<script>` tags defensively.
- `httpRequest`: `fetch` → `{status, headers, text, json?}`; when `throwOnError !==
  false`, throw on status >= 400 (mirror obsidian.ts semantics).
- `showContextMenu(evt, items)`: DOM popup at cursor, class `claudesk-menu`, item class
  `claudesk-menu-item` (icon via setIcon + title), dismiss on outside click / Esc.
- `createModal` / `createSuggestModal`: DOM overlays appended to `document.body`
  matching the ModalHost/SuggestModalHost contracts in `src/platform/types.ts` and the
  base-class behavior in `src/platform/modals.ts` (async onOpen allowed; suggest modal:
  input, live re-query on input, ArrowUp/Down + Enter + click selection, Esc closes).
  Use Obsidian's structural class names so existing styles map: `modal-container`,
  `modal-bg`, `modal`, `modal-close-button`, `modal-title`, `modal-content`; suggest:
  `prompt`, `prompt-input`, `prompt-results`, `suggestion-item` (+`is-selected`).
- `vaultFeatures`: leave `undefined` (shared code already degrades via `?.`).

### Agent B main process

- `app/src/main.ts`: single-instance lock; `app.dock.hide()`; Tray (menu-bar): use a
  16x16 template `nativeImage` if straightforward, else `tray.setTitle("✳")`; tray menu
  = Toggle Claude (shows hotkey ⌥Space), Quit.
- `globalShortcut.register("Alt+Space")` → toggle panel.
- Panel `BrowserWindow`: `width: 800, height: 640, frame: false, show: false,
  type: "panel", transparent: true, backgroundColor: "#00000000", alwaysOnTop
  ("screen-saver"), visibleOnAllWorkspaces({visibleOnFullScreen: true}),
  skipTaskbar: true, webPreferences: {nodeIntegration: true, contextIsolation: false,
  backgroundThrottling: false}`. Position on show: display containing the cursor,
  horizontally centered, top edge at ~18% of workArea height.
- Show: `win.show()` + focus. Hide: `win.hide()` then `app.hide()` so focus returns to
  the previous app. Hide on window blur.
- IPC contract (exact channel names — Agent C depends on them):
  - renderer → main `"claudesk:hide"`: hide the panel (Esc path).
  - main → renderer `"claudesk:shown"`: sent after every show; renderer focuses input.
- `win.loadFile("app/index.html")`. Keep the renderer alive when hidden (processes/tabs
  stay warm). `window-all-closed` must NOT quit; Quit only via tray.
- `app/index.html`: `<div id="app"></div>`, stylesheets `../styles.css` (repo root) and
  `./desktop.css`, script `./dist/renderer.js`. Title "Claude".
- Build: extend `esbuild.config.mjs` with an `--app` mode building
  `app/src/main.ts → app/dist/main.js` (platform node, external: electron) and
  `app/src/renderer.ts → app/dist/renderer.js` (bundle, external: electron + node
  builtins, same settings as the plugin build otherwise; must NOT import `obsidian`).
  The default (no-flag) build must keep producing the Obsidian plugin exactly as today.
- `package.json` scripts: `"build:app": "node esbuild.config.mjs --app"`,
  `"dev:app": "node esbuild.config.mjs --app --watch"`,
  `"start:app": "npm run build:app && electron app/dist/main.js"`.
- `tsconfig.json`: ensure `app/src` is typechecked by `npm run typecheck` (esbuild
  doesn't typecheck). A renderer file importing from `../../src/...` must resolve.
- Add a guard in the renderer build so importing `"obsidian"` anywhere in the app
  bundle fails the build loudly (e.g. esbuild alias/plugin that throws).

### Agent C renderer

- `app/src/renderer.ts` boot order mirrors `src/main.ts` `onload()`:
  `installDomHelpers()` → resolve config → `initializePlatform(new DesktopPlatform({baseDir}))`
  → load settings → construct `DesktopHost` → `refreshMcpDenyPatterns()` →
  catalogs (`discoverSkillsAndCommands`, `discoverSubagents`) → mount `DesktopChatShell`
  into `#app`.
- App config: `~/Library/Application Support/ClaudeQuickChat/config.json`
  (`{ workingDir: string }`), created on first run with default
  `"/Users/henryortega/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain"`
  (the vault — same files, sessions, and `.claude` config as the plugin). `baseDir` =
  `workingDir`.
- Settings: reuse `ClaudeChatSettings`/`DEFAULT_SETTINGS` from `src/settings-data`
  (import from there, NOT `src/settings` — that pulls obsidian). Persist as JSON at
  `<baseDir>/.claude-cli-chat/desktop-settings.json`; seed on first run with defaults +
  `autodetectClaudePath()` + `autodetectUserName()`. `saveSettings()` writes it (reuse
  the atomic-write helper from `src/mcp/MCPConfig` if exported).
- `app/src/host.ts`: `export class DesktopHost implements PluginHost` — wire the same
  members `src/main.ts` holds: `new SubprocessManager()`, `new SpeechController(() =>
  settings)`, `new PermissionsConfigStore(null)`, `new Persistence(null)` (they take
  AppHandle and use `platform.storage`), skill/subagent catalogs via the discovery fns,
  `getMcpServers` via `listMcpServersViaCli` with the same cache/inflight coalescing as
  main.ts, `mcpDenyPatterns` + `refreshMcpDenyPatterns` via `MCPConfigStore(null)`
  (mirror main.ts logic), `getVaultPath()` → baseDir. `createActiveFileIndicator` /
  `createSelectionTracker` → inert stubs satisfying the Handle interfaces (detached
  root div; every method a no-op returning the obvious empties).
- `app/src/shell.ts`: `DesktopChatShell` — a port of `src/view/ClaudeChatView.ts`
  minus ItemView: same composition (renderHeader → nav row with TabBar → tabs
  container → TabController per tab), same tab lifecycle (create/select/close/restore
  via Persistence), and the SAME window-lock protocol (`.claude-cli-chat/window.lock`,
  `<pid>:<uuid>` token, live-PID check) so the desktop app and the Obsidian plugin
  never restore the same tabs concurrently; if the lock is held, render the
  already-open placeholder with the holder described as "another Claude window
  (Obsidian?)" plus a Retry button. Read ClaudeChatView.ts closely and mirror it;
  Remote Control toggle may be stubbed with a `platform.notify("Remote Control: use
  the Obsidian plugin")` for now.
- Keyboard: Esc → `ipcRenderer.send("claudesk:hide")` UNLESS a modal/menu/suggest
  popup is open or the input has non-empty text (check DOM for `.modal-container` /
  `.claudesk-menu`). `ipcRenderer.on("claudesk:shown")` → focus the active tab's input
  (find TabController's focus pathway; add none to src/).
  Cmd+T new tab, Cmd+W close tab (window close is main's job, not Cmd+W).

### Agent D stylesheet

- `app/desktop.css`, loaded AFTER `styles.css`. Two jobs:
  1. Define the Obsidian CSS variables `styles.css` consumes, on `:root`, dark-theme
     values matching Obsidian's default dark palette (the plugin screenshot):
     `--background-primary #1e1e1e`-family, `--background-primary-alt`,
     `--background-secondary`, `--background-modifier-border`,
     `--background-modifier-hover`, `--text-normal`, `--text-muted`, `--text-faint`,
     `--text-accent`, `--text-error`, `--text-success`, `--interactive-accent`,
     `--font-interface`/`--font-text` (system stack), `--font-monospace`,
     `--font-text-size 15px`. Check styles.css for which `--claudian-*` vars it
     defines itself vs consumes; define any missing. Also generic classes shared code
     relies on from Obsidian's theme where obvious (`.svg-icon` sizing 16px, etc.).
  2. Panel chrome + Agent A's components: `html, body { background: transparent }`;
     `#app` fills the viewport, `border-radius: 12px`, `overflow: hidden`, background
     `var(--background-primary)`, subtle border + shadow; styles for `claudesk-toast`,
     `claudesk-menu`(-item), and the Obsidian-structural modal/prompt classes listed in
     Agent A's contract (centered modal over dimmed `modal-bg`, prompt list styling,
     `.is-selected` highlight).
- Match the plugin's look (dark, Anthropic-orange accents already come from
  styles.css).

## Verification each agent runs

`npm run typecheck` (zero errors in YOUR files; others may be mid-flight),
`npm run build` (plugin unaffected), and once Agent B's build mode exists,
`npm run build:app`. Integration smoke-run is the orchestrator's job.
