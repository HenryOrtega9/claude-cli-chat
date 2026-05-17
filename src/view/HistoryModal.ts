import { App, Modal, setIcon } from "obsidian";
import type { Persistence } from "../storage/Persistence";

type ConversationRow = {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
};

export class HistoryModal extends Modal {
  /* Guards against a second click landing while the first onPick is still
     mid-flight. Without it, a user double-clicking a row (or clicking two
     rows in quick succession) could spawn two tab-creation paths racing
     each other, leading to an orphaned empty tab. */
  private processing = false;

  constructor(
    app: App,
    private persistence: Persistence,
    private onPick: (conversationId: string) => void
  ) {
    super(app);
  }

  async onOpen() {
    this.titleEl.setText("Conversation history");
    this.contentEl.addClass("claudian-history-modal");

    const list = this.contentEl.createDiv({ cls: "claudian-history-list" });
    const conversations = await this.persistence.listConversations();

    if (conversations.length === 0) {
      list.createDiv({ cls: "claudian-history-empty", text: "No past conversations yet." });
      return;
    }

    for (const conv of conversations) {
      this.renderRow(list, conv);
    }
  }

  private renderRow(parent: HTMLElement, conv: ConversationRow) {
    const row = parent.createDiv({ cls: "claudian-history-row" });

    const main = row.createDiv({ cls: "claudian-history-main" });
    main.createDiv({ cls: "claudian-history-title", text: conv.title || "Untitled" });
    main.createDiv({
      cls: "claudian-history-meta",
      text: `${conv.messageCount} message${conv.messageCount === 1 ? "" : "s"} • ${this.relativeDate(conv.updatedAt)}`,
    });

    const openBtn = row.createSpan({
      cls: "claudian-history-action",
      attr: { "aria-label": "Open in new tab", title: "Open in new tab" },
    });
    setIcon(openBtn, "external-link");

    row.addEventListener("click", () => {
      if (this.processing) return;
      this.processing = true;
      /* Visually disable the whole list so the user gets feedback that the
         click took. The modal closes synchronously below, but the underlying
         tab creation is async — flagging here ensures a stray late click
         can't slip through before close() tears the DOM down. */
      row.addClass("is-disabled");
      this.onPick(conv.id);
      this.close();
    });
  }

  private relativeDate(ts: number): string {
    const diff = Date.now() - ts;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "just now";
    if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  onClose() {
    this.contentEl.empty();
  }
}
