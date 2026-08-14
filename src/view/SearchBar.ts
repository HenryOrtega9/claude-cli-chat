import { platform } from "../platform";

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
  /* Streaming renders blow away the message DOM (and thus our <mark> nodes)
     while the search bar is open. Watch the container for mutations and
     re-run refreshMatches() to re-wrap matches against the new DOM. Debounced
     so a burst of deltas during a streaming token storm doesn't cause one
     refresh per character. */
  private mutationObserver: MutationObserver | null = null;
  private refreshDebounceTimer: number | null = null;

  constructor(parent: HTMLElement, messagesContainer: HTMLElement) {
    this.messagesContainer = messagesContainer;
    this.root = parent.createDiv({ cls: "claudian-search-bar" });
    this.root.style.display = "none";

    const iconEl = this.root.createSpan({ cls: "claudian-search-icon" });
    platform.setIcon(iconEl, "search");

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
    platform.setIcon(prevBtn, "chevron-up");
    prevBtn.addEventListener("click", () => this.step(-1));

    const nextBtn = this.root.createSpan({ cls: "claudian-search-btn", attr: { "aria-label": "Next", title: "Next (Enter)" } });
    platform.setIcon(nextBtn, "chevron-down");
    nextBtn.addEventListener("click", () => this.step(1));

    const closeBtn = this.root.createSpan({ cls: "claudian-search-btn", attr: { "aria-label": "Close", title: "Close (Esc)" } });
    platform.setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());
  }

  open() {
    this.root.style.display = "";
    this.visible = true;
    this.input.value = "";
    this.input.focus();
    this.refreshMatches();
    this.attachMutationObserver();
  }

  close() {
    this.root.style.display = "none";
    this.visible = false;
    this.detachMutationObserver();
    this.clearMarks();
  }

  isOpen(): boolean { return this.visible; }

  /* Tear down on tab close. Without this, a tab destroyed while search is open
     leaks the MutationObserver (it survives target removal until disconnected)
     and the pending debounce timer, both of which keep the messages container
     and the whole SearchBar/TabController graph reachable across tab churn. */
  destroy() {
    this.detachMutationObserver();
    this.clearMarks();
    this.root.remove();
  }

  /* Subscribe to DOM mutations inside the messages container so streaming
     re-renders that wipe our marks trigger an automatic re-highlight. Skips
     mutations that only touched <mark> nodes (those are our own work — the
     wrap/unwrap operations would otherwise feed back into us). */
  private attachMutationObserver() {
    if (typeof MutationObserver === "undefined") return;
    if (this.mutationObserver) return;
    this.mutationObserver = new MutationObserver((mutations) => {
      let shouldRefresh = false;
      for (const m of mutations) {
        const onlyMarks = (nodes: NodeList) => {
          for (const n of Array.from(nodes)) {
            if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === "MARK") continue;
            if (n.nodeType === Node.TEXT_NODE) {
              const parent = (n as Text).parentElement;
              if (parent && parent.tagName === "MARK") continue;
            }
            return false;
          }
          return true;
        };
        if (m.type === "childList" && onlyMarks(m.addedNodes) && onlyMarks(m.removedNodes)) continue;
        shouldRefresh = true;
        break;
      }
      if (!shouldRefresh) return;
      if (this.refreshDebounceTimer !== null) window.clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = window.setTimeout(() => {
        this.refreshDebounceTimer = null;
        if (this.visible) this.refreshMatches(true);
      }, 50);
    });
    this.mutationObserver.observe(this.messagesContainer, { childList: true, subtree: true, characterData: true });
  }

  private detachMutationObserver() {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    if (this.refreshDebounceTimer !== null) {
      window.clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }
  }

  /* fromObserver=true means this refresh was triggered by a streaming
     re-render, not an explicit user action. In that case we preserve the
     user's navigated position (clamped to the new match count) instead of
     snapping back to match #1, and we suppress scrollIntoView so the viewport
     isn't yanked away from where they're reading on every debounce tick. */
  private refreshMatches(fromObserver = false) {
    /* Suspend the observer around our own DOM edits. wrapMatches/clearMarks
       insert the non-matching text slices as plain text nodes whose parent is
       the message bubble, not a <mark> — so the onlyMarks() filter in the
       observer does NOT skip them, and every refresh would schedule another
       refresh in 50ms: a perpetual self-feeding loop while a matching query is
       open. Disconnecting drops the records our edits generate; refreshMatches
       re-scans the whole container anyway, so nothing real is missed. */
    const obs = this.mutationObserver;
    if (obs) obs.disconnect();
    try {
      this.refreshMatchesInner(fromObserver);
    } finally {
      if (obs && this.visible) {
        obs.observe(this.messagesContainer, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  private refreshMatchesInner(fromObserver: boolean) {
    const prevActiveIndex = this.activeIndex;
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
    if (fromObserver && this.marks.length > 0) {
      this.activeIndex = Math.min(prevActiveIndex, this.marks.length - 1);
    } else {
      this.activeIndex = 0;
    }
    this.updateActive(!fromObserver);
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

  private updateActive(scroll = true) {
    for (const m of this.marks) m.removeClass("is-active");
    const m = this.marks[this.activeIndex];
    if (m) {
      m.addClass("is-active");
      if (scroll) m.scrollIntoView({ block: "center", behavior: "auto" });
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
    /* Final sweep: any <mark.claudian-search-mark> that escaped tracking
       (parent was detached mid-flight, MutationObserver replaced subtree, etc.)
       gets unwrapped now so stale highlights don't survive a close/reopen. */
    const strays = this.messagesContainer.querySelectorAll<HTMLElement>("mark.claudian-search-mark");
    const strayParents = new Set<Node>();
    for (const stray of Array.from(strays)) {
      const parent = stray.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(stray.textContent ?? ""), stray);
      strayParents.add(parent);
    }
    for (const p of strayParents) {
      if (p instanceof HTMLElement) p.normalize();
    }
  }
}
