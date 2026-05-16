import type { App } from "obsidian";
import type { ChatMessage, TabState, ToolCall } from "../view/state";

/* Persisted shape of a tab. Excludes runtime-only state (pendingApprovals,
   busy) since those are bound to a live subprocess and cannot survive a
   restart. Per-tab overrides (model/effort/mode/snippet) DO persist so the
   user's tab settings survive an Obsidian reload. */
type StoredTab = {
  id: string;
  sessionId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
  model?: string;
  effort?: string;
  permissionMode?: string;
  envSnippetId?: string;
  pinnedFilePaths?: string[];
};

type StoredMessage = {
  id: string;
  role: ChatMessage["role"];
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  durationMs?: number;
  thinking?: string;
  selectionContext?: ChatMessage["selectionContext"];
};

type TabIndex = {
  activeTabId: string | null;
  tabs: Array<{ id: string; title: string; sessionId: string | null }>;
};

export class Persistence {
  private dir = ".claude-cli-chat";
  private convDir = `${this.dir}/conversations`;
  private indexPath = `${this.dir}/tabs.json`;
  private pendingWrites = new Map<string, { handle: ReturnType<typeof setTimeout>; state: TabState }>();

  constructor(private app: App) {}

  private async ensureDirs(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
    if (!(await adapter.exists(this.convDir))) await adapter.mkdir(this.convDir);
  }

  async loadIndex(): Promise<TabIndex | null> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.indexPath))) return null;
    try {
      return JSON.parse(await adapter.read(this.indexPath)) as TabIndex;
    } catch {
      return null;
    }
  }

  async loadTab(id: string): Promise<TabState | null> {
    const adapter = this.app.vault.adapter;
    const path = this.convPath(id);
    if (!(await adapter.exists(path))) return null;
    try {
      const stored = JSON.parse(await adapter.read(path)) as StoredTab;
      return {
        id: stored.id,
        sessionId: stored.sessionId,
        title: stored.title,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        messages: stored.messages,
        pendingApprovals: new Map(),
        busy: false,
        model: stored.model,
        effort: stored.effort,
        permissionMode: stored.permissionMode,
        envSnippetId: stored.envSnippetId,
        pinnedFilePaths: stored.pinnedFilePaths,
      };
    } catch {
      return null;
    }
  }

  async saveIndex(index: TabIndex): Promise<void> {
    await this.ensureDirs();
    await this.app.vault.adapter.write(this.indexPath, JSON.stringify(index, null, 2));
  }

  /* Debounced per-tab write. Coalesces rapid streaming updates so we write
     at most once every 500ms per tab. */
  scheduleSaveTab(state: TabState): void {
    const existing = this.pendingWrites.get(state.id);
    if (existing) clearTimeout(existing.handle);
    const handle = setTimeout(() => {
      this.pendingWrites.delete(state.id);
      void this.saveTab(state);
    }, 500);
    this.pendingWrites.set(state.id, { handle, state });
  }

  async saveTab(state: TabState): Promise<void> {
    await this.ensureDirs();
    const stored: StoredTab = {
      id: state.id,
      sessionId: state.sessionId,
      title: state.title,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      messages: state.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolCalls: m.toolCalls,
        durationMs: m.durationMs,
        thinking: m.thinking,
        selectionContext: m.selectionContext,
      })),
      model: state.model,
      effort: state.effort,
      permissionMode: state.permissionMode,
      envSnippetId: state.envSnippetId,
      pinnedFilePaths: state.pinnedFilePaths,
    };
    await this.app.vault.adapter.write(this.convPath(state.id), JSON.stringify(stored, null, 2));
  }

  async deleteTab(id: string): Promise<void> {
    const pending = this.pendingWrites.get(id);
    if (pending) {
      clearTimeout(pending.handle);
      this.pendingWrites.delete(id);
    }
    const adapter = this.app.vault.adapter;
    const path = this.convPath(id);
    if (await adapter.exists(path)) await adapter.remove(path);
  }

  /* Flush all pending debounced writes. Called on plugin unload so the
     last 500ms of edits aren't lost. */
  async flush(): Promise<void> {
    const entries = Array.from(this.pendingWrites.values());
    this.pendingWrites.clear();
    for (const { handle, state } of entries) {
      clearTimeout(handle);
      await this.saveTab(state);
    }
  }

  /* List stored tab files (used by the History dropdown). Returns metadata
     only — no message bodies. */
  async listConversations(): Promise<Array<{ id: string; title: string; updatedAt: number; messageCount: number }>> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.convDir))) return [];
    const listing = await adapter.list(this.convDir);
    const out: Array<{ id: string; title: string; updatedAt: number; messageCount: number }> = [];
    for (const file of listing.files) {
      if (!file.endsWith(".json")) continue;
      try {
        const stored = JSON.parse(await adapter.read(file)) as StoredTab;
        out.push({
          id: stored.id,
          title: stored.title || "Untitled",
          updatedAt: stored.updatedAt,
          messageCount: stored.messages.length,
        });
      } catch {
        /* skip unreadable files */
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  private convPath(id: string): string {
    return `${this.convDir}/${id}.json`;
  }
}
