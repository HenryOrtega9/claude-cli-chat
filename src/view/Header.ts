import { setIcon } from "obsidian";
import { CLAUDE_ASTERISK_DATA_URI } from "./Welcome";

export type HeaderCallbacks = {
  onNewTab: () => void;
  onClear: () => void;
  onHistory: () => void;
  onSnippets: () => void;
  onMcp: () => void;
  onToggleRemoteControl: () => void;
};

export function renderHeader(parent: HTMLElement, callbacks: HeaderCallbacks): HTMLElement {
  const header = parent.createDiv({ cls: "claudian-header" });

  const titleSlot = header.createDiv({ cls: "claudian-title-slot" });
  const logo = titleSlot.createSpan({ cls: "claudian-logo" });
  const logoImg = logo.createEl("img");
  logoImg.src = CLAUDE_ASTERISK_DATA_URI;
  logoImg.alt = "Claude";
  titleSlot.createEl("h4", { text: "Claude", cls: "claudian-title-text" });

  const actions = header.createDiv({ cls: "claudian-header-actions claudian-header-actions-slot" });

  const newTabBtn = actions.createSpan({
    cls: "claudian-header-btn claudian-new-tab-btn",
    attr: { "aria-label": "New chat tab", title: "New chat tab" },
  });
  setIcon(newTabBtn, "square-plus");
  newTabBtn.addEventListener("click", () => callbacks.onNewTab());

  const clearBtn = actions.createSpan({
    cls: "claudian-header-btn",
    attr: { "aria-label": "Clear current chat", title: "Clear current chat" },
  });
  setIcon(clearBtn, "square-pen");
  clearBtn.addEventListener("click", () => callbacks.onClear());

  const snippetsBtn = actions.createSpan({
    cls: "claudian-header-btn",
    attr: { "aria-label": "Environment snippets", title: "Apply environment snippet" },
  });
  setIcon(snippetsBtn, "layers");
  snippetsBtn.addEventListener("click", () => callbacks.onSnippets());

  const mcpBtn = actions.createSpan({
    cls: "claudian-header-btn",
    attr: { "aria-label": "MCP servers", title: "Manage MCP servers" },
  });
  setIcon(mcpBtn, "plug-zap");
  mcpBtn.addEventListener("click", () => callbacks.onMcp());

  const historyBtn = actions.createSpan({
    cls: "claudian-header-btn",
    attr: { "aria-label": "Conversation history", title: "Conversation history" },
  });
  setIcon(historyBtn, "history");
  historyBtn.addEventListener("click", () => callbacks.onHistory());

  const remoteBtn = actions.createSpan({
    cls: "claudian-header-btn",
    attr: { "aria-label": "Toggle Remote Control", title: "Toggle Remote Control" },
  });
  setIcon(remoteBtn, "smartphone");
  remoteBtn.addEventListener("click", () => callbacks.onToggleRemoteControl());

  return header;
}
