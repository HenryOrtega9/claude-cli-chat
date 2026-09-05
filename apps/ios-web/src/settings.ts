/* Settings sheet — the phone's equivalent of the plugin's settings tab
   (src/settings.ts) for the handful of fields a phone is allowed to own.

   Today that is the Defaults section — the model, reasoning effort and
   permission mode every NEW chat is seeded with — plus Replies, which owns
   the typewriter reveal and the reply-suggestion pass for this device.
   The first two already flowed through to tab creation
   (IosChatShell.createTab posts host.settings.defaultModel/defaultEffort,
   and TabController falls back to the same pair at spawn time) — until now
   there was simply no way to change them from the phone, so the seed was
   whatever renderer.ts's applyIosDefaultModel picked.

   Persistence rides the existing path, not a new one: writes land on
   host.settings and RemoteHost.saveSettings() mirrors the device-owned
   subset (defaultModel, defaultEffort, permissionMode, titles, voice,
   typewriter, reply suggestions) into localStorage under "vaultgw.settings". Nothing here touches the Mac's
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
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_ORDER,
  TYPEWRITER_SPEED_MAX,
  TYPEWRITER_SPEED_MIN,
  clampTypewriterSpeed,
  effortLevelsForModel,
  type EffortLevel,
  type ModelKey,
  type PermissionMode,
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

  /* bypassPermissions is not a legal value anywhere in this client (see
     RemoteHost.loadDeviceSettings and the composer popup filter in shell.ts),
     so the picker never offers it. */
  const modeRow = body.createDiv({ cls: "vaultgw-settings-row" });
  modeRow.createSpan({ cls: "vaultgw-settings-label", text: "Permission mode" });
  const modeSelect = modeRow.createEl("select", { cls: "vaultgw-settings-select" });
  /* Annotated: TS 5.5+ infers a type predicate for this arrow, which narrows
     the array's element type to the four offered modes and then rejects the
     `modes.includes(host.settings.permissionMode)` guard below — the exact
     widening check that guard exists to perform. Same four options either
     way; only the static type is widened back. */
  const modes: PermissionMode[] = PERMISSION_MODE_ORDER.filter((m) => m !== "bypassPermissions");
  for (const mode of modes) {
    modeSelect.createEl("option", { value: mode, text: PERMISSION_MODE_LABELS[mode] });
  }
  const modeNote = body.createDiv({ cls: "vaultgw-settings-note" });
  function renderModeNote(): void {
    modeNote.setText(PERMISSION_MODE_DESCRIPTIONS[modeSelect.value as PermissionMode] ?? "");
  }
  modeSelect.value = modes.includes(host.settings.permissionMode) ? host.settings.permissionMode : "acceptEdits";
  renderModeNote();

  body.createDiv({
    cls: "vaultgw-settings-hint",
    text: "Seeds every new chat. Chats already open keep the model, effort and permission mode they were started with — change those from the composer's pills.",
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

  modeSelect.addEventListener("change", () => {
    transport.haptic("selection");
    host.settings.permissionMode = modeSelect.value as PermissionMode;
    renderModeNote();
    void host.saveSettings();
  });

  renderEffort();

  /* ----- Replies ---------------------------------------------------------- */

  /* All three are device-owned (RemoteHost.DeviceSettings): the reveal is a
     rendering choice made in this WebView, and the suggestion pass is billed
     the same either way, so the phone can differ from the Mac's plugin
     without either side rewriting the other's stored settings. */

  body.createDiv({ cls: "vaultgw-settings-section", text: "Replies" });

  const typeRow = body.createDiv({ cls: "vaultgw-settings-row" });
  typeRow.createSpan({ cls: "vaultgw-settings-label", text: "Animate replies" });
  const typeToggle = typeRow.createEl("input", {
    cls: "vaultgw-settings-toggle",
    attr: { type: "checkbox", "aria-label": "Animate replies" },
  });
  typeToggle.checked = host.settings.typewriterEnabled;

  const speedRow = body.createDiv({ cls: "vaultgw-settings-row" });
  speedRow.createSpan({ cls: "vaultgw-settings-label", text: "Animation speed" });
  const speedControl = speedRow.createDiv({ cls: "vaultgw-settings-slider-wrap" });
  const speedValue = speedControl.createSpan({ cls: "vaultgw-settings-value" });
  const speedSlider = speedControl.createEl("input", {
    cls: "vaultgw-settings-slider",
    attr: {
      type: "range",
      min: String(TYPEWRITER_SPEED_MIN),
      max: String(TYPEWRITER_SPEED_MAX),
      step: "10",
      "aria-label": "Animation speed in characters per second",
    },
  });

  /* One writer for both the slider position and the readout, so a clamp on
     load (a blob written before the bounds moved) shows the value actually
     in force rather than the one that was stored. */
  function renderSpeed(): void {
    const cps = clampTypewriterSpeed(host.settings.typewriterSpeed);
    host.settings.typewriterSpeed = cps;
    speedSlider.value = String(cps);
    speedValue.setText(`${cps}/s`);
  }
  renderSpeed();

  /* The slider only means anything while the reveal is on; dimming it beats
     hiding the row, which would make the sheet's rows jump on every tap. */
  function renderTypewriter(): void {
    speedRow.toggleClass("is-disabled", !host.settings.typewriterEnabled);
    speedSlider.disabled = !host.settings.typewriterEnabled;
  }
  renderTypewriter();

  typeToggle.addEventListener("change", () => {
    transport.haptic("selection");
    host.settings.typewriterEnabled = typeToggle.checked;
    renderTypewriter();
    void host.saveSettings();
  });

  /* `input` for the live readout, `change` for the write: dragging a range
     fires input per pixel, and each one would be a localStorage write. */
  speedSlider.addEventListener("input", () => {
    speedValue.setText(`${speedSlider.value}/s`);
  });
  speedSlider.addEventListener("change", () => {
    transport.haptic("selection");
    host.settings.typewriterSpeed = clampTypewriterSpeed(Number(speedSlider.value));
    renderSpeed();
    void host.saveSettings();
  });

  const suggestRow = body.createDiv({ cls: "vaultgw-settings-row" });
  suggestRow.createSpan({ cls: "vaultgw-settings-label", text: "Suggest a reply" });
  const suggestToggle = suggestRow.createEl("input", {
    cls: "vaultgw-settings-toggle",
    attr: { type: "checkbox", "aria-label": "Suggest a reply" },
  });
  suggestToggle.checked = host.settings.replySuggestions;

  body.createDiv({
    cls: "vaultgw-settings-hint",
    text: "After each reply the Mac runs a short Haiku pass to propose your next message. It shows as ghost text in the composer — tap the chip to use it.",
  });

  suggestToggle.addEventListener("change", () => {
    transport.haptic("selection");
    host.settings.replySuggestions = suggestToggle.checked;
    void host.saveSettings();
  });

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
