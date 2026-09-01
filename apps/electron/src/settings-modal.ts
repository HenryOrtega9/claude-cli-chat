/* Settings modal for the standalone shell.

   The Obsidian plugin has a full settings TAB (src/settings.ts, Obsidian-only
   UI classes). This is deliberately NOT a port of it: it covers only the
   settings that exist because the app is a standalone shell — the global
   hotkey, the working directory, and the CLI path — while everything the chat
   itself owns (model, effort, permission mode, voice, snippets) stays where it
   already lives, on the composer chips and in desktop-settings.json.

   Three fields, three different persistence paths, on purpose:

   - hotkey        -> config.json "hotkey", written by the MAIN process after
                      it successfully re-registers the accelerator. The modal
                      only proposes a value over IPC and reports the answer;
                      Electron's registration is the validator.
   - working dir   -> config.json "workingDir", written here (the renderer owns
                      that field). Takes effect on relaunch.
   - claude path   -> desktop-settings.json "claudePath" via host.saveSettings,
                      the same field and writer the plugin uses. Takes effect
                      on the next spawn. */

import { ipcRenderer } from "electron";
import { stat } from "node:fs/promises";
import { PlatformModal } from "../../../src/platform";
import { autodetectClaudePath } from "../../../src/settings-autodetect";
import { DEFAULT_HOTKEY, loadAppConfig, saveWorkingDir } from "./config";
import type { DesktopHost } from "./host";

/* Mirrors the channel name in app/src/main.ts. Duplicated rather than shared
   because main and renderer are separate bundles with no common module (main
   cannot import anything that reaches src/platform). */
const IPC_SET_HOTKEY = "claudesk:set-hotkey";

/* What main answers on that channel: `active` is the accelerator registered
   NOW, so a rejected value still tells us what to show. */
type SetHotkeyResult = { ok: boolean; active: string };

/* One settings modal at a time. Both entry points (the tray item and the
   header button / Cmd+,) can fire while one is already up, and stacked copies
   of the same form would let two views of one field drift apart. */
let openInstance: DesktopSettingsModal | null = null;

/* Last accelerator main told us about, from either an open-settings payload or
   a set-hotkey answer. Only main knows what is really registered — config.json
   can hold a value that failed to bind at startup — and the channel set is
   fixed, so this cache is how a later Cmd+, open gets the truth instead of the
   file's guess. Null until main has spoken. */
let lastKnownHotkey: string | null = null;

export function openSettingsModal(host: DesktopHost, activeHotkey?: string): void {
  if (activeHotkey) lastKnownHotkey = activeHotkey;
  if (openInstance) return;
  const modal = new DesktopSettingsModal(host, activeHotkey ?? lastKnownHotkey);
  openInstance = modal;
  modal.open();
}

type StatusTone = "ok" | "error";

export class DesktopSettingsModal extends PlatformModal {
  /* Named around PlatformModal's own private `host` (the ModalHost), which
     a subclass field called `host` would collide with. */
  private readonly desktopHost: DesktopHost;
  /* Best known live accelerator. Null until resolved in onOpen: main's own
     value when it opened us, else the last one it reported, else config.json's
     stored value. Re-seeded from every IPC answer. */
  private activeHotkey: string | null;
  /* onOpen is async (it reads config.json); the user can dismiss the modal
     before it resolves, and painting into a torn-down contentEl would leak a
     detached tree that the next open() would then duplicate. */
  private closed = false;

  constructor(host: DesktopHost, activeHotkey?: string | null) {
    super(null);
    this.desktopHost = host;
    this.activeHotkey = activeHotkey ?? null;
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Claude Quick Chat settings");
    this.contentEl.addClass("claudesk-settings-modal");

    const config = await loadAppConfig();
    if (this.closed) return;
    /* config.json is the last resort: it holds what SHOULD be bound, which is
       what is actually bound unless registration failed at startup. */
    this.activeHotkey = this.activeHotkey ?? config.hotkey;

    this.buildHotkeyField();
    this.buildWorkingDirField(config.workingDir);
    this.buildClaudePathField();
  }

  onClose(): void {
    this.closed = true;
    if (openInstance === this) openInstance = null;
    this.contentEl.empty();
  }

  /* ----- fields --------------------------------------------------------- */

  private buildHotkeyField(): void {
    const field = this.addField(
      "Global hotkey",
      "Electron accelerator, e.g. Alt+Space, Command+Shift+K. Applies immediately.",
    );
    this.addTextRow(field, {
      value: this.activeHotkey ?? DEFAULT_HOTKEY,
      placeholder: DEFAULT_HOTKEY,
      buttonLabel: "Apply",
      onSubmit: async (value, input) => {
        const requested = value.trim();
        if (requested.length === 0) {
          this.setStatus(field.status, "Enter an accelerator, e.g. Alt+Space.", "error");
          return;
        }
        const result = await this.requestHotkey(requested);
        this.activeHotkey = result.active;
        lastKnownHotkey = result.active;
        /* Snap the field back to what is really bound, so a rejected value
           can't sit in the box looking accepted. */
        input.value = result.active;
        if (result.ok) {
          this.setStatus(field.status, `Hotkey is now ${result.active}.`, "ok");
        } else {
          this.setStatus(
            field.status,
            `Could not register ${requested} — invalid, or already taken by another app. Still using ${result.active}.`,
            "error",
          );
        }
      },
    });
  }

  private buildWorkingDirField(workingDir: string): void {
    const field = this.addField(
      "Working directory",
      "Absolute path the chat runs against: spawn cwd, saved tabs, skills, and .claude config all resolve here. Applies after you relaunch the app.",
    );
    this.addTextRow(field, {
      value: workingDir,
      placeholder: workingDir,
      buttonLabel: "Save",
      onSubmit: async (value) => {
        const next = value.trim();
        if (next.length === 0) {
          this.setStatus(field.status, "Enter an absolute folder path.", "error");
          return;
        }
        /* Refuse a path that isn't a directory TODAY rather than accepting it
           and failing at the next boot: every storage call resolves against
           this, so a bad value means an app that starts to a broken panel with
           no UI left to fix it from. */
        let isDir = false;
        try {
          isDir = (await stat(next)).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          this.setStatus(field.status, `No folder at ${next}.`, "error");
          return;
        }
        try {
          await saveWorkingDir(next);
        } catch (err) {
          this.setStatus(field.status, `Could not save: ${describeError(err)}`, "error");
          return;
        }
        this.setStatus(field.status, "Saved. Quit and reopen Claude to switch folders.", "ok");
      },
    });
  }

  private buildClaudePathField(): void {
    const field = this.addField(
      "Claude CLI path",
      "Absolute path to the `claude` binary. Leave empty to autodetect. Applies to the next chat you start.",
    );
    this.addTextRow(field, {
      value: this.desktopHost.settings.claudePath,
      placeholder: autodetectClaudePath() || "/path/to/claude",
      buttonLabel: "Save",
      onSubmit: async (value) => {
        const next = value.trim();
        this.desktopHost.settings.claudePath = next;
        try {
          await this.desktopHost.saveSettings();
        } catch (err) {
          this.setStatus(field.status, `Could not save: ${describeError(err)}`, "error");
          return;
        }
        this.setStatus(
          field.status,
          next.length > 0 ? `Saved: ${next}` : "Cleared — the CLI will be autodetected.",
          "ok",
        );
      },
    });
  }

  /* ----- field plumbing ------------------------------------------------- */

  private addField(name: string, description: string): { control: HTMLElement; status: HTMLElement } {
    const item = this.contentEl.createDiv({ cls: "claudesk-setting" });
    item.createDiv({ cls: "claudesk-setting-name", text: name });
    item.createDiv({ cls: "claudesk-setting-desc setting-item-description", text: description });
    const control = item.createDiv({ cls: "claudesk-setting-control" });
    const status = item.createDiv({ cls: "claudesk-setting-status" });
    return { control, status };
  }

  private addTextRow(
    field: { control: HTMLElement; status: HTMLElement },
    opts: {
      value: string;
      placeholder: string;
      buttonLabel: string;
      onSubmit: (value: string, input: HTMLInputElement) => Promise<void>;
    },
  ): void {
    const input = field.control.createEl("input", {
      type: "text",
      value: opts.value,
      placeholder: opts.placeholder,
    });
    input.spellcheck = false;
    const button = field.control.createEl("button", { cls: "mod-cta", text: opts.buttonLabel });

    /* Serialize submits: click and Enter both land here, and every handler
       writes shared state (config.json, desktop-settings.json, the live
       accelerator), which two interleaved runs could leave inconsistent. */
    let busy = false;
    const submit = async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      try {
        await opts.onSubmit(input.value, input);
      } catch (err) {
        this.setStatus(field.status, describeError(err), "error");
      } finally {
        busy = false;
        button.disabled = false;
      }
    };

    button.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      /* Enter submits the row it belongs to, and goes no further: nothing
         behind the modal (the composer, the window-level handlers in
         renderer.ts) should see a keystroke aimed at a settings field. */
      e.preventDefault();
      e.stopPropagation();
      void submit();
    });
  }

  private setStatus(el: HTMLElement, message: string, tone: StatusTone): void {
    el.setText(message);
    el.toggleClass("is-error", tone === "error");
    el.toggleClass("is-ok", tone === "ok");
  }

  /* Round-trip the proposed accelerator through main, which registers it (the
     only real validation available) and persists it on success. A malformed
     answer is treated as a rejection so the UI never claims a binding we
     can't confirm. */
  private async requestHotkey(accelerator: string): Promise<SetHotkeyResult> {
    const reply: unknown = await ipcRenderer.invoke(IPC_SET_HOTKEY, accelerator);
    if (reply !== null && typeof reply === "object") {
      const { ok, active } = reply as { ok?: unknown; active?: unknown };
      if (typeof ok === "boolean" && typeof active === "string") return { ok, active };
    }
    return { ok: false, active: this.activeHotkey ?? DEFAULT_HOTKEY };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
