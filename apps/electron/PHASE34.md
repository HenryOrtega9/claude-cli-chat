# Phases 3 & 4 — Polish and packaging for the standalone shell

Context: Phases 1-2 are DONE. `app/` holds a working Electron menu-bar app (⌥Space
panel) hosting the shared chat code via `src/platform/`. Read `app/PHASE2.md` for the
architecture, contracts, and invariants — all still binding (plugin build untouched and
byte-stable except where this spec says otherwise, TypeScript strict, repo comment
style, macOS only). `npm run typecheck`, `npm run build`, `npm run build:app` all pass
today; keep it that way.

## Phase 3 — Polish (two agents, disjoint ownership)

### P3-A: platform http + import tidiness
Owns: `app/src/desktop-platform.ts` (and may add a private helper module in `app/src/`),
plus the two one-line type-import retypes below.
1. Reimplement `DesktopPlatform.httpRequest` on `node:http`/`node:https` instead of
   renderer `fetch`, so LAN calls have no CORS preflight (Obsidian's `requestUrl` is
   CORS-exempt; the desktop shell must match). Preserve the exact `HttpResponse`
   contract and `obsidian.ts` semantics: throw `Error("Request failed, status <n>")`
   on >= 400 when `throwOnError !== false`; `json` degrades to `undefined`; honor
   `method`, `contentType`, `headers`, `body`. Known consumer to un-break:
   `src/claude/StateEmitter.ts` POSTs JSON to an AWTRIX device at
   `http://192.168.12.126` (TC001 status display) and races a 500ms timeout — a plain
   POST with Content-Type must go out with no preflight. Follow redirects (up to 5),
   timeout via the caller's own race (no internal timeout below 10s).
2. Tidiness: `src/platform/host.ts` and `src/voice/SpeechController.ts` still have
   type-only imports from `../settings`; repoint to `../settings-data` (identical
   symbols via re-export). These are the ONLY `src/` edits allowed, and they must not
   change emitted plugin output.

### P3-B: hotkey config, tray, login item, settings modal
Owns: `app/src/main.ts`, `app/src/renderer.ts`, `app/src/config.ts`,
`app/src/shell.ts` (only if wiring demands it), new `app/src/settings-modal.ts`,
`app/desktop.css` (additive only), `app/PHASE2.md` untouched.
1. **Configurable hotkey**: `config.json` (`~/Library/Application Support/
   ClaudeQuickChat/config.json`) gains optional `"hotkey"` (Electron accelerator
   string, default `"Alt+Space"`). The main process reads it at startup (duplicate the
   path constant in main.ts — main cannot import renderer modules) and registers it;
   invalid/failed registration falls back to Alt+Space and logs. Tray menu label shows
   the active accelerator.
2. **Tray icon**: replace the "✳" title with a real 16x16 (+@2x) template
   `nativeImage` of the Claude asterisk. Generate PNGs at build time or commit tiny
   generated assets under `app/assets/` (document how they were produced); mark
   `setTemplateImage(true)` so macOS renders it correctly in light/dark menu bars.
3. **Start at Login**: tray menu checkbox via `app.setLoginItemSettings({openAtLogin})`
   / `getLoginItemSettings()`. Enabled only when `app.isPackaged` (in dev it would
   register the bare electron binary); disabled menu item with tooltip-style suffix
   "(packaged app only)" otherwise.
4. **Settings modal**: new `settings-modal.ts` using the existing platform modal
   pathway (`PlatformModal` from `src/platform/modals`), opened two ways: a tray menu
   item "Settings…" → IPC `"claudesk:open-settings"` → renderer opens it, and (if
   trivially wireable) from the shell. Fields: hotkey (text input, validated by a
   round-trip IPC `"claudesk:set-hotkey"` that main answers with success/failure after
   re-registering — on failure re-register the previous one and report), working
   directory (text path; persists to config.json; note in the modal that it applies
   after relaunch), claude CLI path override (persists into desktop-settings.json's
   existing `claudePath` field via the host's saveSettings). Main process owns all
   config.json WRITES for hotkey (renderer sends the value over IPC); workingDir may be
   written by the renderer (it already owns config.json reads/seeds — keep one writer
   per field and document which).
5. New IPC channels (exact names): `"claudesk:open-settings"` (main→renderer),
   `"claudesk:set-hotkey"` (renderer→main, `ipcRenderer.invoke` style returning
   `{ok: boolean, active: string}`).

## Phase 3 verification (verify agent)
`npm run typecheck` + `npm run build` + `npm run build:app` all green; launch
`npx electron app/dist/main.js` headlessly for ~10s with `ELECTRON_ENABLE_LOGGING=1`,
assert no renderer errors in the log (Electron's dev CSP warning is expected noise) and
that the process stays alive; kill it and confirm the vault window.lock is released.
The verify agent MAY fix small integration residue itself (wrong import path, missed
rename); anything structural gets reported instead.

## Phase 4 — Packaging (one agent)

Owns: `package.json` (devDeps + scripts + builder config), `esbuild.config.mjs`
(`--production` flag only), `app/assets/`, new builder config files, `.gitignore`
additions. Must not edit `app/src/*` except a truly unavoidable one-liner (report it).

1. **Production build mode**: `--app --production` in `esbuild.config.mjs` → minified,
   no inline sourcemaps (dev default stays as-is). Script `"build:app:prod"`.
2. **electron-builder**: add as devDep. The plugin's `package.json` `"main"` field is
   `main.js` (Obsidian contract — MUST NOT change); use builder `extraMetadata.main:
   "app/dist/main.js"` (or a dedicated builder config with the same effect).
   - `files`: `app/dist/**`, `app/index.html`, `app/desktop.css`, `styles.css`,
     `app/assets/**` — preserving repo-relative layout so `../styles.css` from
     `app/index.html` resolves inside the asar. No `node_modules` are needed at
     runtime (renderer bundles everything; verify the packaged app proves it).
   - mac config: `target: "dir"`, `identity: null` (ad-hoc signing is fine for a
     personal app), `appId: "dev.henryortega.claude-quick-chat"`, `productName:
     "Claude Quick Chat"`, `extendInfo: { LSUIElement: true }` (menu-bar only, no
     Dock icon even before app.dock.hide runs), icon from an `.icns` you generate
     from the Claude asterisk SVG (`src/view/Welcome.ts` has the path data; sips +
     iconutil pipeline; commit the .icns under `app/assets/`).
   - Auto-update: none (matches how Henry runs self-built apps).
3. Script `"package:app": "npm run build:app:prod && electron-builder --mac dir --config <cfg>"`,
   output under `app/release/` (gitignored).
4. Build it. Verify `app/release/mac*/Claude Quick Chat.app` exists and
   `codesign -dv` shows ad-hoc; `mdls`/`defaults read` the Info.plist for LSUIElement.

## Phase 4 final verification (verify agent)
1. Copy the built app to `/Applications/Claude Quick Chat.app` (replace if present —
   first install, nothing pre-existing to preserve).
2. `open -a "Claude Quick Chat"`; wait ~8s; assert the process is running, then check
   boot artifacts: config.json untouched/valid, no crash logs
   (`~/Library/Logs/DiagnosticReports` fresh entries for the app), window.lock
   acquired-then-released after `osascript -e 'quit app "Claude Quick Chat"'` (or
   `pkill -f "Claude Quick Chat"` fallback; confirm lock file absent afterwards).
3. Do NOT enable Start-at-Login — leave that to Henry via the tray toggle.
4. Report: .app path, bundle size, packaged-run result, and any manual step remaining
   (e.g. macOS Accessibility/Input Monitoring prompts, first-run Gatekeeper note for
   unsigned apps — with the exact right-click-Open workaround if applicable).
