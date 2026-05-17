import { Notice, setIcon } from "obsidian";
import type { RemoteStatus } from "../claude/RemoteControlSession";

export type PairingCardCallbacks = {
  onDisconnect: () => void;
};

export class RemotePairingCard {
  private root: HTMLElement;
  private statusEl: HTMLElement;
  private urlEl: HTMLAnchorElement;
  private copyBtn: HTMLElement;
  private callbacks: PairingCardCallbacks;
  private url: string | null = null;

  constructor(parent: HTMLElement, callbacks: PairingCardCallbacks) {
    this.callbacks = callbacks;

    this.root = parent.createDiv({ cls: "claudian-remote-card" });
    this.root.style.display = "none";

    const header = this.root.createDiv({ cls: "claudian-remote-header" });
    const iconEl = header.createSpan({ cls: "claudian-remote-icon" });
    setIcon(iconEl, "smartphone");
    header.createSpan({ cls: "claudian-remote-title", text: "Remote Control" });
    this.statusEl = header.createSpan({ cls: "claudian-remote-status" });
    this.setStatus("starting");

    const body = this.root.createDiv({ cls: "claudian-remote-body" });
    body.createDiv({
      cls: "claudian-remote-hint",
      text: "Open the link below on your phone or at claude.ai/code to drive this conversation remotely.",
    });

    const urlRow = body.createDiv({ cls: "claudian-remote-url-row" });
    this.urlEl = urlRow.createEl("a", { cls: "claudian-remote-url", attr: { href: "#", target: "_blank" } });
    this.urlEl.setText("Waiting for pairing URL...");
    this.copyBtn = urlRow.createSpan({
      cls: "claudian-remote-copy",
      attr: { "aria-label": "Copy URL", title: "Copy URL" },
    });
    setIcon(this.copyBtn, "copy");
    this.copyBtn.addEventListener("click", () => this.copyUrl());

    const actions = body.createDiv({ cls: "claudian-remote-actions" });
    const disconnectBtn = actions.createEl("button", { cls: "claudian-remote-disconnect", text: "Disconnect" });
    disconnectBtn.addEventListener("click", () => this.callbacks.onDisconnect());
  }

  show() { this.root.style.display = ""; }
  hide() { this.root.style.display = "none"; }

  setUrl(url: string) {
    this.url = url;
    this.urlEl.setText(url);
    /* Guard against javascript: / data: / file: URLs that could ride in via
       a compromised pairing transport — assigning straight to `.href` would
       make them clickable. Only http(s) gets to be a real link; anything else
       renders as plain text and is logged so we notice if it's a real upstream
       bug rather than an attack. */
    if (url.startsWith("https://") || url.startsWith("http://")) {
      this.urlEl.href = url;
    } else {
      this.urlEl.removeAttribute("href");
      console.warn(`RemotePairingCard: refusing to assign non-http(s) URL: ${url}`);
    }
  }

  setStatus(status: RemoteStatus) {
    this.statusEl.empty();
    this.statusEl.removeClass("status-starting", "status-waiting", "status-ready", "status-exited", "status-error");
    this.statusEl.addClass(`status-${status}`);
    this.statusEl.setText(this.statusLabel(status));
  }

  destroy() { this.root.remove(); }

  private statusLabel(status: RemoteStatus): string {
    switch (status) {
      case "starting": return "Starting...";
      case "waiting": return "Waiting for pairing";
      case "ready": return "Paired";
      case "exited": return "Disconnected";
      case "error": return "Error";
    }
  }

  private copyUrl() {
    if (!this.url) return;
    void navigator.clipboard.writeText(this.url);
    new Notice("Pairing URL copied");
  }
}
