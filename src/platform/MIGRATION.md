# Platform migration conventions

Read this whole file before touching a shared file. It is the single source of
truth for the obsidian-decoupling phase: which files migrate, exactly what each
one uses from `obsidian`, and the mechanical replacement for every usage.

## The layer

- `src/platform/types.ts` — the `Platform` interface + capability types. Imports nothing.
- `src/platform/registry.ts` — `export let platform: Platform` + `initializePlatform(p)`.
- `src/platform/modals.ts` — `PlatformModal` / `PlatformSuggestModal` base classes (obsidian-free, delegate to `platform.createModal` / `createSuggestModal`).
- `src/platform/host.ts` — `PluginHost` (the plugin surface shared code may see) + `ActiveSelection`, `ActiveFileIndicatorHandle`, `SelectionTrackerHandle`. Type-only imports exclusively.
- `src/platform/obsidian.ts` — `ObsidianPlatform`. The ONLY platform file importing `obsidian`. Only `main.ts` may import it.
- `src/platform/index.ts` — public surface. Shared code imports from here (`../platform`) or from `../platform/host`; never from `../platform/obsidian`.

`main.ts` calls `initializePlatform(new ObsidianPlatform(this.app))` as the
first statement of `onload()`, so `platform` is always live before any shared
code runs. `ClaudeChatPlugin` already implements the `PluginHost` factory
methods (`createActiveFileIndicator`, `createSelectionTracker`).

## File classification

Obsidian-only — KEEP importing obsidian, never migrated:

- `src/main.ts`
- `src/view/ClaudeChatView.ts`
- `src/view/ActiveFileIndicator.ts`
- `src/view/SelectionTracker.ts`
- `src/view/SnippetPicker.ts`
- the settings-tab UI portion of `src/settings.ts`

Shared — must end with ZERO `obsidian` imports (and no imports from
Obsidian-only files, `import type` included):

- `src/claude/StateEmitter.ts`
- `src/mcp/MCPConfig.ts`
- `src/permissions/PermissionsConfig.ts`
- `src/storage/Persistence.ts`
- `src/util/officeExtract.ts`
- `src/view/TabController.ts`
- `src/view/InputBox.ts`
- `src/view/MessageRenderer.ts`
- `src/view/SearchBar.ts`
- `src/view/Header.ts`
- `src/view/TabBar.ts`
- `src/view/RemotePairingCard.ts`
- `src/view/ApprovalModal.ts`
- `src/view/HistoryModal.ts`
- `src/view/MCPManagerModal.ts`
- `src/view/SubagentManagerModal.ts`
- `src/view/CreateSubagentModal.ts`
- `src/view/SubagentPicker.ts`

(`src/settings.ts`'s data model becomes shared after the split handled by the
settings agent; until then, shared files importing types/values from
`../settings` are acceptable and NOT counted as violations.)

## Hard rules

1. **Public APIs and constructor signatures of migrated files must NOT
   change.** Callers in other agents' files must keep compiling unchanged.
   Where a parameter is typed with an obsidian type today, keep the parameter
   and retype it:
   - `app: App` → `app: AppHandle` (from `../platform`; it is `unknown`, so
     every existing `new X(this.app, ...)` call site still compiles). The
     migrated body ignores the parameter and uses `platform.*`.
   - `component: Component` → `component: RenderLifecycle` (also `unknown`).
   - `plugin: ClaudeChatPlugin` → `plugin: PluginHost` (from
     `../platform/host`). The real plugin satisfies it structurally.
   - `adapter: DataAdapter` (writeJsonAtomic) → `adapter: FileStorage`.
     Callers that today pass `this.app.vault.adapter` migrate in the same
     pass to pass `platform.storage`.
2. **No shared file imports obsidian, directly or via an Obsidian-only
   file** — `import type` from an Obsidian-only file counts as a violation
   (the standalone build must not need to compile main.ts/ClaudeChatView).
3. **Behavior is preserved exactly.** These are mechanical rewrites. Do not
   refactor, rename, or "improve" while migrating.
4. **`platform` is read inside methods only**, never at module-evaluation
   time (it is assigned in `onload`).
5. Obsidian's global DOM augmentations (`createDiv`, `createSpan`,
   `createEl`, `empty`, `setText`, `addClass`, `toggleClass`, `setAttr`, …)
   are ambient types, not imports — keep using them. Supplying them in the
   standalone shell is a later-phase concern, not part of this migration.

## Per-API replacement recipes

| Obsidian usage | Platform replacement |
|---|---|
| `import { X } from "obsidian"` | delete; `import { platform, ... } from "../platform"` (adjust relative depth) |
| `new Notice(msg)` | `platform.notify(msg)` |
| `new Notice(msg, 6000)` | `platform.notify(msg, 6000)` |
| `setIcon(el, "icon-id")` | `platform.setIcon(el, "icon-id")` |
| `await MarkdownRenderer.render(this.app, md, el, "", this.component)` | `await platform.renderMarkdown(md, el, "", this.component)` (retype the stored `component` field to `RenderLifecycle`) |
| `requestUrl({ url, method, contentType, body, throw: false })` | `platform.httpRequest({ url, method, contentType, body, throwOnError: false })` |
| `new Menu()` + `addItem(i => i.setTitle(t).setIcon(ic).onClick(fn))` + `showAtMouseEvent(e)` | `platform.showContextMenu(e, [{ title: t, icon: ic, onClick: fn }])` |
| `extends Modal` | `extends PlatformModal` (from `../platform`); keep `super(app)`, `onOpen`/`onClose`, `this.contentEl`, `this.titleEl`, `open()`, `close()` verbatim |
| `extends SuggestModal<T>` | `extends PlatformSuggestModal<T>`; keep `super(app)`, `setPlaceholder`, `getSuggestions`, `renderSuggestion`, `onChooseSuggestion` verbatim |
| `this.app.vault.adapter.exists/read/readBinary/write/rename/remove/mkdir/list(p)` | `platform.storage.<same method>(p)` (paths stay vault-root-relative; identical semantics) |
| `adapter instanceof FileSystemAdapter` + `adapter.getBasePath()` | `const base = platform.storage.basePath(); if (base === null) return;` |
| `app.vault.getAbstractFileByPath(p) instanceof TFile/TFolder` (kind check only) | `platform.vaultFeatures?.pathKind(p) === "file"` / `=== "folder"` |
| `file instanceof TFile ? file.stat.mtime : undefined` | `platform.vaultFeatures?.fileMtime(p)` |
| `vault.getFiles()` + folder walk from `vault.getRoot()` (mention index) | `platform.vaultFeatures?.listIndexEntries() ?? []` |
| `refs.push(vault.on("create"/"delete"/"rename", cb))` … `vault.offref(ref)` | `this.unsub = platform.vaultFeatures?.onTreeChange(cb) ?? null` … `this.unsub?.()` (field type `(() => void) \| null`; drop the `EventRef` import) |
| `workspace.getActiveFile()?.path ?? ""` | `platform.vaultFeatures?.activeFilePath() ?? ""` |
| `metadataCache.getFirstLinkpathDest(link, src)?.path` | `platform.vaultFeatures?.resolveLink(link, src)` (returns `string \| null`) |
| `workspace.openLinkText(link, "", "tab" \| "split")` | `platform.vaultFeatures?.openPath(link, "tab" \| "split")` |
| `workspace.trigger("hover-link", {...})` | `platform.vaultFeatures?.triggerHoverLink(event, targetEl, linkpath, this.component)` |
| `(this.app as unknown as { dragManager?: ... })` reads | `platform.vaultFeatures?.readDragPaths() ?? []` |
| `import type ClaudeChatPlugin from "../main"` | `import type { PluginHost } from "../platform/host"` |
| `new ActiveFileIndicator(parent, this.app, pinned, sticky, cbs)` | `this.plugin.createActiveFileIndicator(parent, pinned, sticky, cbs)` (field type `ActiveFileIndicatorHandle`) |
| `new SelectionTracker(this.app, cb)` | `this.plugin.createSelectionTracker(cb)` (field type `SelectionTrackerHandle`) |
| `import type { ActiveSelection } from "./SelectionTracker"` | `import type { ActiveSelection } from "../platform/host"` (identical shape) |

`vaultFeatures` is optional by design (the desktop shell omits it). In shared
code always access it with `?.` and pick the neutral fallback shown above —
under Obsidian it is always present, so behavior is unchanged.

## Modal migration example

Before:

```ts
import { App, Modal, setIcon } from "obsidian";

export class HistoryModal extends Modal {
  constructor(app: App, private persistence: Persistence, private onPick: (id: string) => void) {
    super(app);
  }
  async onOpen() {
    this.titleEl.setText("Conversation history");
    this.contentEl.addClass("claudian-history-modal");
    // ...
    setIcon(openBtn, "external-link");
  }
  onClose() { this.contentEl.empty(); }
}
```

After:

```ts
import { platform, PlatformModal, type AppHandle } from "../platform";

export class HistoryModal extends PlatformModal {
  constructor(app: AppHandle, private persistence: Persistence, private onPick: (id: string) => void) {
    super(app);
  }
  async onOpen() {
    this.titleEl.setText("Conversation history");
    this.contentEl.addClass("claudian-history-modal");
    // ...
    platform.setIcon(openBtn, "external-link");
  }
  onClose() { this.contentEl.empty(); }
}
```

Call sites (`new HistoryModal(this.app, ...)` in ClaudeChatView) compile
unchanged. Same pattern for `SubagentPicker` with `PlatformSuggestModal<T>`.

## Usage catalog (every obsidian API each shared file touches)

- **`src/claude/StateEmitter.ts`** — `requestUrl` only: fail-silent POST of
  `/api/switch` to the TC001 with `throw: false`, raced against a 500ms
  timeout. → `platform.httpRequest({ ..., throwOnError: false })`.
- **`src/mcp/MCPConfig.ts`** — `Notice` ×2 (corrupt `.claude/mcp.json`
  backup notices in `load()`); `App` (ctor param, used solely for
  `app.vault.adapter`); `DataAdapter` type (`writeJsonAtomic` param + local
  `adapter` vars; methods used: `write`, `rename`, `exists`, `remove`,
  `mkdir`, `read`). → `platform.notify` + `platform.storage`; retype
  `writeJsonAtomic(adapter: FileStorage, ...)`.
- **`src/permissions/PermissionsConfig.ts`** — `Notice` ×2 (corrupt
  `.claude/settings.json` backup); `App` (ctor → `vault.adapter`:
  `exists`/`mkdir`/`read`). → same as MCPConfig.
- **`src/storage/Persistence.ts`** — `App` (ctor → `vault.adapter`:
  `exists`, `mkdir`, `read`, `remove`, `list`, plus writes via
  `writeJsonAtomic`); `FileSystemAdapter` (`flushSync`: `instanceof` guard +
  `getBasePath()` for synchronous node-fs quit-time writes). →
  `platform.storage`; `flushSync` uses `platform.storage.basePath()`,
  returning early on `null` (same degradation as the current guard).
- **`src/util/officeExtract.ts`** — `App` type only
  (`extractOfficeText(app, path)` / `readVaultBinary`:
  `app.vault.adapter.readBinary`). → `platform.storage.readBinary`; keep the
  first parameter, retyped `AppHandle`, ignored.
- **`src/view/TabController.ts`** — the big one:
  - `Notice` ×10 (lines ~454, 786, 797, 827, 857, 876, 965, 1287, 2310,
    2577): user-facing notices for incognito/remote guard, `/clear`,
    `/help` (12000ms), unknown subagent (8000ms), empty catalog (8000ms),
    busy guard, "Stopped Claude.", office-extract failure, usage-cap notice
    (8000ms), "Trusted <path>".
  - `App` (`this.app = plugin.app`): `vault.on/offref`
    (mention-index invalidation), `vault.getAbstractFileByPath` (+
    `instanceof TFile` for `officeFileMtime`; `instanceof TFile/TFolder` in
    `tryPinVaultPath`), `vault.getFiles` + `vault.getRoot` + `TFolder` walk
    (`getMentionIndex`), `workspace.getActiveFile` +
    `metadataCache.getFirstLinkpathDest` (wikilink fallback), internal
    `dragManager` reads (`readDragManagerPaths`, incl. `TFile`/`TFolder`
    instanceof and link-drag resolution). → `platform.vaultFeatures`
    (`fileMtime`, `pathKind`, `listIndexEntries`, `onTreeChange`,
    `activeFilePath`, `resolveLink`, `readDragPaths`). Delete the `this.app`
    field entirely once nothing reads it.
  - `Component` (held as `this.component`, forwarded to
    `MessageListRenderer`) → retype field + ctor param to `RenderLifecycle`.
  - `EventRef[]` (`mentionIndexRefs`) → single unsubscribe closure from
    `onTreeChange`.
  - `TFile`/`TFolder` — only ever `instanceof` checks; all covered above.
  - Constructs `ActiveFileIndicator` / `SelectionTracker` /
    `CreateSubagentModal` / `SubagentPicker` with `this.app` — factories /
    `AppHandle` per the recipes.
- **`src/view/InputBox.ts`** — `setIcon` ×11 (toolbar pills, chips, icons);
  `Notice` ×7 (folder-path failures ×3, oversize paste, oversize file,
  attach failure). Plus the `ActiveSelection` type import seam (below).
- **`src/view/MessageRenderer.ts`** — `MarkdownRenderer.render(this.app,
  content, block, "", this.component)` (assistant markdown); `App`:
  `vault.getAbstractFileByPath` + `instanceof TFolder` (note-pill
  folder/file icon + click guard), `workspace.openLinkText` ×3 (note pill
  click "tab"; internal-link click "tab"/"split"; middle-click "tab"),
  `workspace.trigger("hover-link", { event, source: "claude-cli-chat",
  hoverParent: this.component, targetEl, linktext, sourcePath: "" })`;
  `Component` (ctor param + field, render lifecycle + hoverParent);
  `Notice` ×1 ("Copied message"); `setIcon` ×14 (tool icons, status icons,
  chevrons, pills, attachments, fork/copy actions); `TFolder` (instanceof
  only). → `platform.renderMarkdown`, `platform.vaultFeatures?.pathKind` /
  `openPath` / `triggerHoverLink`, `platform.notify`, `platform.setIcon`;
  ctor `(app: AppHandle, component: RenderLifecycle, container)`.
- **`src/view/SearchBar.ts`** — `setIcon` ×4.
- **`src/view/Header.ts`** — `setIcon` ×6.
- **`src/view/TabBar.ts`** — `setIcon` ×2; `Menu` (right-click one-item
  "Close tab" menu, icon "x", `showAtMouseEvent`). →
  `platform.showContextMenu(e, [{ title: "Close tab", icon: "x", onClick }])`.
- **`src/view/RemotePairingCard.ts`** — `Notice` ×1 ("Pairing URL copied");
  `setIcon` ×2.
- **`src/view/ApprovalModal.ts`** — despite the filename it is NOT a modal
  (ApprovalArea, plain DOM). `setIcon` ×1.
- **`src/view/HistoryModal.ts`** — `extends Modal` (`super(app)`, async
  `onOpen`, `onClose`, `titleEl`, `contentEl`, `close()`); `setIcon` ×1;
  `App` ctor param.
- **`src/view/MCPManagerModal.ts`** — `extends Modal` (async `onOpen`,
  `onClose`, `titleEl`, `contentEl`); `Notice` ×2; `App` ctor param;
  `import type ClaudeChatPlugin` seam.
- **`src/view/SubagentManagerModal.ts`** — `extends Modal`; `Notice` ×3;
  `App` ctor param; plugin-type seam. (File open/reveal already use
  `spawn("open", ...)`, not Obsidian.)
- **`src/view/CreateSubagentModal.ts`** — `extends Modal`; `Notice` ×6;
  `App` ctor param; plugin-type seam. (Writes agent files via node fs, not
  the vault adapter — leave that alone.)
- **`src/view/SubagentPicker.ts`** — `extends SuggestModal<SubagentEntry>`
  (`super(app)`, `setPlaceholder`, `getSuggestions`, `renderSuggestion`,
  `onChooseSuggestion`); `App` ctor param.

## Seams: existing shared → Obsidian-only imports (and the prescribed fix)

1. `TabController` → `./ActiveFileIndicator` (value import + construction).
   Fix: field retyped `ActiveFileIndicatorHandle`; construct via
   `this.plugin.createActiveFileIndicator(...)`; delete the import.
2. `TabController` → `./SelectionTracker` (value import + `ActiveSelection`
   type). Fix: field retyped `SelectionTrackerHandle`; construct via
   `this.plugin.createSelectionTracker(...)`; take `ActiveSelection` from
   `../platform/host`; delete the import.
3. `TabController` → `../main` (`import type ClaudeChatPlugin`). Fix:
   `PluginHost`.
4. `InputBox` → `./SelectionTracker` (`import type { ActiveSelection }`).
   Fix: import the identical type from `../platform/host`. (Optionally the
   view agent adds `export type { ActiveSelection } from "../platform/host"`
   to SelectionTracker.ts and deletes its local copy, so one definition
   exists; SelectionTracker is Obsidian-only, so touching it is allowed.)
5. `MCPManagerModal`, `SubagentManagerModal`, `CreateSubagentModal` →
   `../main` (`import type ClaudeChatPlugin`). Fix: `PluginHost`.
6. `TabController`, `InputBox` → `../settings`. NOT a violation to fix here —
   the settings agent splits the data model out; these imports keep their
   path per that agent's plan.

## Known follow-ups deliberately OUT of scope for this phase

- Obsidian's `HTMLElement` prototype helpers (`createDiv` etc.) are used by
  every view file as ambient globals. The standalone shell needs a polyfill;
  no migration action now.
- `addIcon` / `getFrontMatterInfo` / `Plugin` / `ItemView` / `WorkspaceLeaf` /
  `Editor` / `MarkdownView` / `PluginSettingTab` / `Setting` /
  `FileSystemAdapter`-in-main are used only by Obsidian-only files and stay.
- Icon ids passed to `platform.setIcon` are lucide names plus
  `"claude-asterisk"` (registered by main.ts via `addIcon`); the standalone
  shell must provide the same vocabulary.

## Verification per migrated file

`grep -n '"obsidian"' <file>` returns nothing; no import path resolves to an
Obsidian-only file; `npm run typecheck` and `npm run build` pass.
