import { setIcon } from "obsidian";

/* In-conversation search. Opens via Cmd+F when the view is focused. Walks the
   messages DOM, wraps every matching text run in a `<mark>` element, and
   cycles between matches with Enter / Shift+Enter. Esc closes and unwraps. */
export class SearchBar {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private countEl: HTMLElement;
  private messagesContainer: HTMLElement;
  private marks: HTMLElement[] = [];
  private activeIndex = 0;
  private visible = false;

  constructor(parent: HTMLElement, messagesContainer: HTMLElement) {
    this.messagesContainer = messagesContainer;
    this.root = parent.createDiv({ cls: "claudian-search-bar" });
    this.root.style.display = "none";

    const iconEl = this.root.createSpan({ cls: "claudian-search-icon" });
    setIcon(iconEl, "search");

    this.input = this.root.createEl("input", {
      cls: "claudian-search-input",
      attr: { type: "text", placeholder: "Find in conversation…" },
    });
    this.input.addEventListener("input", () => this.refreshMatches());
    this.input.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      }
    });

    this.countEl = this.root.createSpan({ cls: "claudian-search-count", text: "" });

    const prevBtn = this.root.createSpan({ cls: "claudian-search-btn", attr: { "aria-label": "Previous", title: "Previous (Shift+Enter)" } });
    setIcon(prevBtn, "chevron-up");
    prevBtn.addEventListener("click", () => this.step(-1));

    const nextBtn = this.root.createSpan({ cls: "claudian-search-btn", attr: { "aria-label": "Next", title: "Next (Enter)" } });
    setIcon(nextBtn, "chevron-down");
    nextBtn.addEventListener("click", () => this.step(1));

    const closeBtn = this.root.createSpan({ cls: "claudian-search-btn", attr: { "aria-label": "Close", title: "Close (Esc)" } });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());
  }

  open() {
    this.root.style.display = "";
    this.visible = true;
    this.input.value = "";
    this.input.focus();
    this.refreshMatches();
  }

  close() {
    this.root.style.display = "none";
    this.visible = false;
    this.clearMarks();
  }

  isOpen(): boolean { return this.visible; }

  private refreshMatches() {
    this.clearMarks();
    const query = this.input.value.trim();
    if (!query) {
      this.countEl.setText("");
      return;
    }
    /* Walk all text nodes inside the messages container, finding case-
       insensitive matches and wrapping them in <mark> elements. We avoid
       re-walking the same nodes by skipping <mark> contents. */
    const walker = document.createTreeWalker(this.messagesContainer, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.tagName === "MARK") return NodeFilter.FILTER_REJECT;
        /* Skip script/style/etc. */
        if (parent.closest(".claudian-bottom-sentinel")) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const lowerQuery = query.toLowerCase();
    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }
    for (const textNode of textNodes) {
      const text = textNode.nodeValue ?? "";
      const lower = text.toLowerCase();
      if (!lower.includes(lowerQuery)) continue;
      this.wrapMatches(textNode, text, lower, lowerQuery);
    }
    this.activeIndex = 0;
    this.updateActive();
    this.updateCount();
  }

  private wrapMatches(node: Text, text: string, lower: string, lowerQuery: string) {
    const parent = node.parentNode;
    if (!parent) return;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let idx = lower.indexOf(lowerQuery, cursor);
    while (idx !== -1) {
      if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
      const mark = document.createElement("mark");
      mark.className = "claudian-search-mark";
      mark.textContent = text.slice(idx, idx + lowerQuery.length);
      frag.appendChild(mark);
      this.marks.push(mark);
      cursor = idx + lowerQuery.length;
      idx = lower.indexOf(lowerQuery, cursor);
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    parent.replaceChild(frag, node);
  }

  private step(delta: number) {
    if (this.marks.length === 0) return;
    this.activeIndex = (this.activeIndex + delta + this.marks.length) % this.marks.length;
    this.updateActive();
    this.updateCount();
  }

  private updateActive() {
    for (const m of this.marks) m.removeClass("is-active");
    const m = this.marks[this.activeIndex];
    if (m) {
      m.addClass("is-active");
      m.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }

  private updateCount() {
    if (this.marks.length === 0) {
      this.countEl.setText(this.input.value ? "0/0" : "");
    } else {
      this.countEl.setText(`${this.activeIndex + 1}/${this.marks.length}`);
    }
  }

  private clearMarks() {
    /* Unwrap by replacing each <mark> with its text content. Parent's
       normalize() merges adjacent text nodes so we don't fragment the DOM. */
    const parentsTouched = new Set<Node>();
    for (const m of this.marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
      parentsTouched.add(parent);
    }
    for (const p of parentsTouched) {
      if (p instanceof HTMLElement) p.normalize();
    }
    this.marks = [];
    this.activeIndex = 0;
  }
}
