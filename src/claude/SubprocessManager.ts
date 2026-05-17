import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StreamJsonParser } from "./StreamJsonParser";
import { InputWriter } from "./InputWriter";
import type { StreamEvent, ControlRequestEvent, ContentBlock } from "./Events";
import { RemoteControlSession } from "./RemoteControlSession";
import { autodetectClaudePath, resolveModelId, type ClaudeChatSettings } from "../settings";

/* Returns PIDs of every running process whose command line matches
   `claude --remote-control`. Used by the settings UI to count live remote
   sessions and by killAllRemoteAndOrphans() to sweep up anything the
   in-process registry doesn't know about (e.g. survivors of a prior plugin
   instance that exited before this cleanup logic landed). */
export function findRemoteControlPids(): number[] {
  try {
    const out = execSync('pgrep -f "claude --remote-control"', { encoding: "utf8" }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));
  } catch {
    return [];
  }
}

export type TabMode = "local" | "remote-control";

export type SpawnOptions = {
  cwd: string;
  sessionId?: string;
  model?: string;
  /** Maps to `--effort`. One of low | medium | high | xhigh | max. */
  effort?: string;
  /** Path to the `claude` binary. Falls back to PATH lookup if empty. */
  claudePath: string;
  permissionMode: ClaudeChatSettings["permissionMode"];
  includePartialMessages: boolean;
  /** Text appended to the system prompt via `--append-system-prompt`. */
  appendSystemPrompt?: string;
};

export type TabSessionStatus = "starting" | "ready" | "running" | "exited" | "error";

type EventListener = (e: StreamEvent) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (err: Error) => void;
type StderrListener = (chunk: string) => void;

/* TabSession wraps a single `claude` subprocess for one chat tab.
   Lifecycle:
     1. constructor() spawns the child with stream-json flags
     2. parser dispatches stdout lines as typed StreamEvents
     3. .sendUserText() writes NDJSON to stdin
     4. .approve() / .deny() reply to a pending control_request
     5. process exit fires .exit listeners; .dispose() can force-kill */
export class TabSession {
  readonly tabId: string;
  sessionId: string | null = null;
  status: TabSessionStatus = "starting";

  private child: ChildProcessWithoutNullStreams;
  private parser = new StreamJsonParser();
  private writer: InputWriter;
  private eventListeners: EventListener[] = [];
  private exitListeners: ExitListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private stderrListeners: StderrListener[] = [];
  private pendingApprovals = new Map<string, ControlRequestEvent>();

  constructor(tabId: string, opts: SpawnOptions) {
    this.tabId = tabId;

    const args = this.buildArgs(opts);
    /* Obsidian (launched from Finder/Dock) does not inherit the shell PATH,
       so `claude` from `~/.local/bin/claude` is not visible. Resolve the
       absolute path here if the user hasn't set one in settings. */
    const cmd = opts.claudePath || autodetectClaudePath() || "claude";

    /* Also enrich PATH with common install dirs so any child processes the
       CLI spawns (e.g. via Bash tool) can find their tools. */
    const home = process.env.HOME ?? "";
    const enrichedPath = [
      process.env.PATH ?? "",
      `${home}/.local/bin`,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].filter(Boolean).join(":");

    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] spawn tab=${tabId}`, { cmd, args, cwd: opts.cwd });

    this.child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        PATH: enrichedPath,
        CLAUDE_CODE_ENTRYPOINT: "claude-cli-chat-plugin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    console.log(`[claude-cli-chat] spawned pid=${this.child.pid}`);

    this.writer = new InputWriter(this.child.stdin);
    this.parser.attach(this.child.stdout);
    this.parser.onEvent(e => this.handleEvent(e));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => {
      console.warn(`[claude-cli-chat] stderr:`, chunk);
      for (const cb of this.stderrListeners) cb(chunk);
    });

    this.child.on("error", err => {
      console.error(`[claude-cli-chat] child error:`, err);
      this.status = "error";
      for (const cb of this.errorListeners) cb(err);
    });

    this.child.on("exit", (code, signal) => {
      console.log(`[claude-cli-chat] exit code=${code} signal=${signal}`);
      this.status = "exited";
      this.parser.detach();
      for (const cb of this.exitListeners) cb(code, signal);
    });
  }

  private buildArgs(opts: SpawnOptions): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", opts.permissionMode,
      "--add-dir", opts.cwd,
    ];
    if (opts.includePartialMessages) args.push("--include-partial-messages");
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    return args;
  }

  private handleEvent(event: StreamEvent) {
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] event type=${event.type}`, event);
    if (event.type === "system" && (event as { subtype?: string }).subtype === "init") {
      const init = event as { session_id?: string };
      if (init.session_id) this.sessionId = init.session_id;
      this.status = "ready";
    } else if (event.type === "control_request") {
      const req = event as ControlRequestEvent;
      this.pendingApprovals.set(req.request_id, req);
    } else if (event.type === "result") {
      this.status = "ready";
    }

    for (const cb of this.eventListeners) cb(event);
  }

  sendUserText(text: string) {
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] sendUserText`, { textPreview: text.slice(0, 80), sessionId: this.sessionId });
    this.status = "running";
    try {
      this.writer.sendUserText(text, this.sessionId ?? undefined);
    } catch (err) {
      console.error(`[claude-cli-chat] sendUserText failed:`, err);
      throw err;
    }
  }

  sendUserContent(blocks: ContentBlock[]) {
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] sendUserContent`, { blockCount: blocks.length, sessionId: this.sessionId });
    this.status = "running";
    try {
      this.writer.sendUserContent(blocks, this.sessionId ?? undefined);
    } catch (err) {
      console.error(`[claude-cli-chat] sendUserContent failed:`, err);
      throw err;
    }
  }

  approve(requestId: string, updatedInput?: Record<string, unknown>) {
    const req = this.pendingApprovals.get(requestId);
    this.pendingApprovals.delete(requestId);
    /* updatedInput is required by the SDK schema — default to the original
       input from the request if the caller didn't pass an override. */
    const input = updatedInput ?? req?.request.input ?? {};
    this.writer.sendApproval(requestId, input);
  }

  deny(requestId: string, reason?: string) {
    this.pendingApprovals.delete(requestId);
    this.writer.sendDenial(requestId, reason);
  }

  getPendingApprovals(): ControlRequestEvent[] {
    return Array.from(this.pendingApprovals.values());
  }

  onEvent(cb: EventListener) { this.eventListeners.push(cb); }
  onExit(cb: ExitListener) { this.exitListeners.push(cb); }
  onError(cb: ErrorListener) { this.errorListeners.push(cb); }
  onStderr(cb: StderrListener) { this.stderrListeners.push(cb); }

  async dispose(): Promise<void> {
    if (this.status === "exited") return;
    this.writer.closeStdin();
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    });
  }
}

/* SubprocessManager owns one TabSession per tab id and provides a small lookup API.
   Phase C will hook this into the view: tab creation calls .spawn(), tab close
   calls .kill(), and the view subscribes to .onEvent() per tab for rendering. */
export class SubprocessManager {
  private sessions = new Map<string, TabSession>();
  private remoteSessions = new Map<string, RemoteControlSession>();

  spawn(tabId: string, opts: SpawnOptions): TabSession {
    const existing = this.sessions.get(tabId);
    if (existing && existing.status !== "exited") return existing;
    const session = new TabSession(tabId, opts);
    session.onExit(() => {
      const current = this.sessions.get(tabId);
      if (current === session) this.sessions.delete(tabId);
    });
    this.sessions.set(tabId, session);
    return session;
  }

  get(tabId: string): TabSession | null {
    return this.sessions.get(tabId) ?? null;
  }

  list(): TabSession[] {
    return Array.from(this.sessions.values());
  }

  /* Track a remote-control session by tab id so it gets reaped on plugin
     unload (killAll) and counted in the settings panel. The caller still
     owns the session reference; we just hold a weak handle here for cleanup.
     If a session was already registered for this tab, dispose the prior one
     first so re-registration doesn't leak. */
  registerRemote(tabId: string, session: RemoteControlSession): void {
    const prior = this.remoteSessions.get(tabId);
    if (prior && prior !== session) void prior.dispose();
    this.remoteSessions.set(tabId, session);
    session.onExit(() => {
      if (this.remoteSessions.get(tabId) === session) this.remoteSessions.delete(tabId);
    });
  }

  unregisterRemote(tabId: string): void {
    this.remoteSessions.delete(tabId);
  }

  listRemote(): RemoteControlSession[] {
    return Array.from(this.remoteSessions.values());
  }

  async killAll(): Promise<void> {
    const local = Array.from(this.sessions.values()).map(s => s.dispose());
    const remote = Array.from(this.remoteSessions.values()).map(s => s.dispose());
    this.sessions.clear();
    this.remoteSessions.clear();
    await Promise.all([...local, ...remote]);
  }

  /* Settings-panel-driven nuke. Disposes every tracked remote session,
     then signals any leftover PIDs the registry doesn't know about
     (orphans from prior plugin instances, dropped tab refs, etc.).
     Returns counts so the UI can confirm what happened. */
  async killAllRemoteAndOrphans(): Promise<{ tracked: number; orphans: number }> {
    const tracked = this.remoteSessions.size;
    const work = Array.from(this.remoteSessions.values()).map(s => s.dispose());
    this.remoteSessions.clear();
    await Promise.all(work);
    let orphans = 0;
    for (const pid of findRemoteControlPids()) {
      try {
        process.kill(pid, "SIGTERM");
        orphans++;
      } catch {
        /* already gone or permission denied — ignore */
      }
    }
    return { tracked, orphans };
  }
}

/* Convenience helper to translate plugin settings into SpawnOptions. */
export function spawnOptionsFromSettings(
  settings: ClaudeChatSettings,
  cwd: string,
  sessionId?: string,
  overrides?: {
    model?: string;
    effort?: string;
    permissionMode?: ClaudeChatSettings["permissionMode"];
    appendSystemPrompt?: string;
  }
): SpawnOptions {
  return {
    cwd,
    sessionId,
    model: overrides?.model ?? resolveModelId(settings.defaultModel),
    effort: overrides?.effort ?? settings.defaultEffort,
    claudePath: settings.claudePath,
    permissionMode: overrides?.permissionMode ?? settings.permissionMode,
    includePartialMessages: settings.includePartialMessages,
    appendSystemPrompt: overrides?.appendSystemPrompt,
  };
}
