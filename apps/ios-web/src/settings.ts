/* Settings sheet — the phone's equivalent of the plugin's settings tab
   (src/settings.ts) for the handful of fields a phone is allowed to own.

   Today that is the Defaults section: the model and reasoning effort every
   NEW chat is seeded with. Both already flowed through to tab creation
   (IosChatShell.createTab posts host.settings.defaultModel/defaultEffort,
   and TabController falls back to the same pair at spawn time) — until now
   there was simply no way to change them from the phone, so the seed was
   whatever renderer.ts's applyIosDefaultModel picked.

   Persistence rides the existing path, not a new one: writes land on
   host.settings and RemoteHost.saveSettings() mirrors the device-owned
   subset (defaultModel, defaultEffort, permissionMode, titles, voice) into
   localStorage under "vaultgw.settings". Nothing here touches the Mac's
   data.json — the vault's copy describes the Mac (claudePath, TC001, vault
   addendum) and the phone deliberately does not get a vote on it.

   Everything the Mac still owns — gateway host, port, bearer token — stays
   in the native SwiftUI screen (apps/ios/Sources/SettingsView.swift), which
   this sheet links out to rather than duplicating: the token lives in the
   Keychain, where the WebView cannot reach it.

   Bespoke overlay rather than the platform Modal shim, same reasoning (and
   the same class shapes) as the usage sheet next door: ios-web owns the
   surface, src/ is untouched. */

import { platform } from "../../../src/platform";
import {
  EFFORT_LABELS,
  MODEL_GROUPS,
  MODEL_IDS,
  MODEL_LABELS,
  MODEL_NOTES,
  effortLevelsForModel,
  type EffortLevel,
  type ModelKey,
} from "../../../src/settings-data";
import type { RemoteHost } from "../../../src/platform/remote/RemoteHost";
import type { GatewayTransport } from "../../../src/platform/remote/transport";

/* The open sheet's close(), if any — the singleton branch below routes a
   second tap through it rather than detaching the DOM behind its own back. */
let activeClose: (() => void) | null = null;

/* A ModelKey the catalog no longer carries (a key deleted from MODEL_IDS
   between the write and this read, or a hand-edited localStorage blob) has
   no label and would render a blank row that silently reassigns the default
   on the next change event. Fall back to the first key of the first group,
   which is what the picker shows at the top anyway. */
function safeModel(key: ModelKey): ModelKey {
  return Object.prototype.hasOwnProperty.call(MODEL_IDS, key) ? key : MODEL_GROUPS[0].keys[0];
}

export function showSettingsSheet(host: RemoteHost, transport: GatewayTransport): void {
  const existing = document.querySelector<HTMLElement>(".vaultgw-settings-overlay");
  if (existing) {
    activeClose?.();
    existing.remove();
    return;
  }

  const overlay = document.body.createDiv({ cls: "vaultgw-usage-overlay vaultgw-settings-overlay" });
  const sheet = overlay.createDiv({ cls: "vaultgw-usage-sheet vaultgw-settings-sheet" });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const head = sheet.createDiv({ cls: "vaultgw-usage-head" });
  head.createSpan({ cls: "vaultgw-usage-title", text: "Settings" });
  const closeBtn = head.createSpan({ cls: "vaultgw-usage-close", attr: { "aria-label": "Close" } });
  platform.setIcon(closeBtn, "x");
  closeBtn.addEventListener("click", close);

  function close(): void {
    overlay.remove();
    if (activeClose === close) activeClose = null;
  }
  activeClose = close;

  const body = sheet.createDiv({ cls: "vaultgw-settings-body" });

  /* ----- Defaults --------------------------------------------------------- */

  body.createDiv({ cls: "vaultgw-settings-section", text: "Defaults" });

  const modelRow = body.createDiv({ cls: "vaultgw-settings-row" });
  modelRow.createSpan({ cls: "vaultgw-settings-label", text: "Model" });
  const modelSelect = modelRow.createEl("select", { cls: "vaultgw-settings-select" });
  /* Grouped exactly as the composer's model popup groups them, so the two
     pickers on the same device never disagree about where a model lives. */
  for (const group of MODEL_GROUPS) {
    const optgroup = modelSelect.createEl("optgroup", { attr: { label: group.header } });
    for (const key of group.keys) {
      optgroup.createEl("option", { value: key, text: MODEL_LABELS[key] });
    }
  }
  modelSelect.value = safeModel(host.settings.defaultModel);

  /* Availability caveats (MODEL_NOTES) are appended to the option label in
     the plugin's dropdown; a phone-width <select> truncates long labels to
     nothing useful, so the note for the SELECTED model gets its own line
     under the row instead. */
  const modelNote = body.createDiv({ cls: "vaultgw-settings-note" });

  const effortRow = body.createDiv({ cls: "vaultgw-settings-row" });
  effortRow.createSpan({ cls: "vaultgw-settings-label", text: "Reasoning effort" });
  const effortSelect = effortRow.createEl("select", { cls: "vaultgw-settings-select" });

  body.createDiv({
    cls: "vaultgw-settings-hint",
    text: "Seeds every new chat. Chats already open keep the model and effort they were started with — change those from the composer's pills.",
  });

  /* Rebuilds the effort options for the current model and clamps the stored
     value if the model change made it illegal. xhigh only exists on Fable,
     Opus and Sonnet 5; leaving it selectable elsewhere would persist a level
     the CLI rejects on the next spawn. Same clamp target ("high") the shell's
     sanitizeRestoredTab and TabController use, so a model swap degrades to
     the nearest legal rung rather than dropping to the ladder's floor. */
  function renderEffort(): boolean {
    const model = modelSelect.value as ModelKey;
    const levels = effortLevelsForModel(model);
    let clamped = false;
    if (!levels.includes(host.settings.defaultEffort)) {
      host.settings.defaultEffort = levels.includes("high") ? "high" : levels[levels.length - 1];
      clamped = true;
    }
    effortSelect.empty();
    for (const level of levels) {
      effortSelect.createEl("option", { value: level, text: EFFORT_LABELS[level] });
    }
    effortSelect.value = host.settings.defaultEffort;
    const note = MODEL_NOTES[model];
    modelNote.setText(note ?? "");
    modelNote.toggleClass("is-hidden", !note);
    return clamped;
  }

  modelSelect.addEventListener("change", () => {
    transport.haptic("selection");
    host.settings.defaultModel = modelSelect.value as ModelKey;
    const clamped = renderEffort();
    void host.saveSettings();
    if (clamped) {
      platform.notify(
        `${MODEL_LABELS[host.settings.defaultModel]} doesn't support that effort level — default effort is now ${EFFORT_LABELS[host.settings.defaultEffort]}.`,
        5000,
      );
    }
  });

  effortSelect.addEventListener("change", () => {
    transport.haptic("selection");
    host.settings.defaultEffort = effortSelect.value as EffortLevel;
    void host.saveSettings();
  });

  renderEffort();

  /* ----- Connection ------------------------------------------------------- */

  /* Native-only: the browser dev build has no SwiftUI screen behind
     openSettings(), and its transport just logs a hint to the console. */
  if (transport.isNative) {
    body.createDiv({ cls: "vaultgw-settings-section", text: "Connection" });
    const link = body.createDiv({ cls: "vaultgw-settings-link" });
    link.createSpan({ text: "Gateway, token & developer" });
    /* external-link rather than a chevron: the destination is the SwiftUI
       sheet, outside this WebView, and "chevron-right" is not in the curated
       icon map (src/platform/dom/desktop-icons.ts) — an unlisted id renders
       nothing and warns, and src/ is not this change's to edit. */
    const chevron = link.createSpan({ cls: "vaultgw-settings-link-icon" });
    platform.setIcon(chevron, "external-link");
    link.addEventListener("click", () => {
      transport.haptic("selection");
      close();
      transport.openSettings();
    });
  }
}
