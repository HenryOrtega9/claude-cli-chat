import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { StreamJsonParser } from "./StreamJsonParser";
import { InputWriter } from "./InputWriter";
import type { StreamEvent, ControlRequestEvent, ContentBlock } from "./Events";
import { RemoteControlSession } from "./RemoteControlSession";
import { autodetectClaudePath, resolveModelId, type ClaudeChatSettings } from "../settings";

/* Returns PIDs of every running Remote Control process. Used by the settings
   UI to count live remote sessions and by killAllRemoteAndOrphans() to sweep
   up anything the in-process registry doesn't know about (e.g. survivors of a
   prior plugin instance that exited before this cleanup logic landed).

   We spawn the `claude remote-control` subcommand, but older orphans may still
   be running as the `claude --remote-control` flag form, so the pattern
   accepts both: optional `--` before `remote-control`.

   The pattern uses pgrep's ERE (`-f` matches the full argv) to require
   `claude` either at the start of the argv or after a `/` (so an absolute
   path matches), followed by whitespace, then `(--)?remote-control` bounded by
   whitespace or end. This avoids false positives like man pages, editor
   buffers, or another tool with `claude remote-control` embedded in a
   longer command. After parsing, we cross-check via `ps -p <pid> -o
   command=` so we only return PIDs whose argv actually begins with the
   claude binary. */
export function findRemoteControlPids(): number[] {
  let raw: string;
  try {
    raw = execSync('pgrep -f "(^|/)claude[[:space:]]+(--)?remote-control([[:space:]]|$)"', { encoding: "utf8" }).trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  const candidates = raw
    .split("\n")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n));

  /* Cross-check each PID's argv to drop false positives that the regex
     somehow let through (e.g. shell wrappers, comment lines in scripts). */
  const verified: number[] = [];
  for (const pid of candidates) {
    try {
      const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
      /* The argv as ps shows it: first token should be `claude` (possibly
         absolute path) and `remote-control` should appear as its own token
         (or the legacy `--remote-control` flag, for old orphans). */
      const argv = cmd.split(/\s+/);
      const first = argv[0] ?? "";
      const isClaude = first === "claude" || /\/claude$/.test(first);
      const hasRc = argv.includes("remote-control") || argv.includes("--remote-control");
      if (isClaude && hasRc) verified.push(pid);
    } catch {
      /* Process gone between pgrep and ps. Skip. */
    }
  }
  return verified;
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
  /** Incognito tabs: launch with `--no-session-persistence` so the CLI writes
      no session transcript to ~/.claude/projects. */
  noSessionPersistence?: boolean;
  /** Per-vault MCP deny rules (`mcp__<server>` patterns). Passed via
      `--settings` so they apply only to this plugin's subprocesses, never to
      the user's other Claude Code instances. Each pattern removes that
      server's tools from the model's advertised tool list. */
  mcpDenyPatterns?: string[];
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
  /* Errors that fire before any onError() listener is registered get queued
     here. This matters for synchronous spawn failures (ENOENT on the claude
     binary): Node fires the `error` event in a nextTick before the caller
     has had a chance to wire up listeners. Drained on first onError(). */
  private earlyErrors: Error[] = [];

  constructor(tabId: string, opts: SpawnOptions) {
    this.tabId = tabId;

    const args = this.buildArgs(opts);
    /* Obsidian (launched from Finder/Dock) does not inherit the shell PATH,
       so `claude` from `~/.local/bin/claude` is not visible. Resolve the
       absolute path here if the user hasn't set one in settings. */
    const cmd = opts.claudePath || autodetectClaudePath() || "claude";

    /* Also enrich PATH with common install dirs so any child processes the
       CLI spawns (e.g. via Bash tool) can find their tools. Guard the
       `~/.local/bin` entry when HOME is unset so we don't inject a bare
       `/.local/bin`. Also include the dir containing the claude binary when
       an explicit path was provided, so sibling tooling resolves alongside
       it. */
    const home = process.env.HOME ?? "";
    const claudeDir = opts.claudePath ? dirname(opts.claudePath) : "";
    const enrichedPath = [
      process.env.PATH ?? "",
      home ? `${home}/.local/bin` : "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      claudeDir,
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
      if (this.errorListeners.length === 0) {
        /* No listeners yet (likely a synchronous spawn failure that fired
           before the caller wired up onError). Queue for delivery on the
           first onError() registration. */
        this.earlyErrors.push(err);
        return;
      }
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
    if (opts.noSessionPersistence) args.push("--no-session-persistence");
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.appendSystemPrompt && opts.appendSystemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }
    /* Per-vault MCP disable. `--settings` accepts an inline JSON string and
       layers on top of the user's own settings; deny rules union across
       layers and win over allow, so this hides the named servers' tools
       without touching ~/.claude.json or any shared settings file. Only
       emitted when something is actually disabled so a fully-enabled vault
       spawns byte-for-byte as before. */
    if (opts.mcpDenyPatterns && opts.mcpDenyPatterns.length > 0) {
      args.push("--settings", JSON.stringify({ permissions: { deny: opts.mcpDenyPatterns } }));
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
  onError(cb: ErrorListener) {
    this.errorListeners.push(cb);
    /* Drain any errors that arrived before listeners existed. We invoke them
       on the next microtask so the caller's registration completes first. */
    if (this.earlyErrors.length > 0) {
      const drained = this.earlyErrors.splice(0, this.earlyErrors.length);
      queueMicrotask(() => {
        for (const err of drained) {
          try { cb(err); } catch { /* listener error swallowed */ }
        }
      });
    }
  }
  onStderr(cb: StderrListener) { this.stderrListeners.push(cb); }

  async dispose(): Promise<void> {
    if (this.status === "exited") return;
    this.writer.closeStdin();
    return new Promise(resolve => {
      /* `status` flips to "exited" asynchronously inside the 'exit' handler, so
         the process can already be gone here even though the check above passed.
         If it is, once('exit') would never fire and we'd block the full 2s for
         nothing (multiplied across tabs on plugin unload). Resolve immediately. */
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const onExit = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.child.removeListener("exit", onExit);
        try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, 2000);
      this.child.once("exit", onExit);
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
  /* Session-file paths already claimed by an active RemoteControlSession.
     Used by the mtime-based session-file poll to avoid picking the same
     JSONL twice under parallel-spawn races. */
  private claimedSessionFiles = new Set<string>();

  /* Returns true on first claim, false if the path was already claimed. The
     poll logic in RemoteControlSession uses this to skip files another
     instance has already grabbed. */
  claimSessionFile(path: string): boolean {
    if (this.claimedSessionFiles.has(path)) return false;
    this.claimedSessionFiles.add(path);
    return true;
  }

  releaseSessionFile(path: string): void {
    this.claimedSessionFiles.delete(path);
  }

  isSessionFileClaimed(path: string): boolean {
    return this.claimedSessionFiles.has(path);
  }

  /* Bridge object matching RemoteControlSession's `claimedSessionFiles`
     option shape. Pass this when constructing a RemoteControlSession so
     parallel spawns coordinate session-file claims. */
  sessionFileClaimAdapter(): { claim(path: string): boolean; isClaimed(path: string): boolean } {
    return {
      claim: (path: string) => this.claimSessionFile(path),
      isClaimed: (path: string) => this.isSessionFileClaimed(path),
    };
  }

  spawn(tabId: string, opts: SpawnOptions): TabSession {
    const existing = this.sessions.get(tabId);
    /* A spawn-level failure (ENOENT on a wrong/missing claudePath, EACCES,
       etc.) leaves the session in status "error" and Node fires only the
       child 'error' event, never 'exit' — so the onExit reaper below never
       runs and the dead session lingers in `sessions`. Treat "error" as
       terminal alongside "exited" so the next attempt replaces it. The
       `this.sessions.set` below overwrites the stale entry; the failed
       child never started, so no manual delete or dispose is needed. */
    if (existing && existing.status !== "exited" && existing.status !== "error") return existing;
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
    if (prior && prior !== session) {
      if (prior.sessionFile) this.releaseSessionFile(prior.sessionFile);
      void prior.dispose();
    }
    this.remoteSessions.set(tabId, session);
    session.onSessionFile((path: string) => {
      /* Best-effort claim: the session may have already claimed the path
         itself via the poll loop. Calling claim() again is a no-op. */
      this.claimSessionFile(path);
    });
    session.onExit(() => {
      if (this.remoteSessions.get(tabId) === session) this.remoteSessions.delete(tabId);
      if (session.sessionFile) this.releaseSessionFile(session.sessionFile);
    });
  }

  unregisterRemote(tabId: string): void {
    const session = this.remoteSessions.get(tabId);
    if (session?.sessionFile) this.releaseSessionFile(session.sessionFile);
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
    this.claimedSessionFiles.clear();
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
      /* Pre-flight: confirm the PID still exists AND still looks like a
         claude --remote-control process. PIDs can be reused on a busy
         system; between findRemoteControlPids() and the kill below, the
         original process may have exited and a new program may have taken
         its slot. process.kill(pid, 0) is a no-signal existence probe;
         ESRCH means the process is gone. */
      try { process.kill(pid, 0); } catch { continue; }
      /* Verify argv still matches (cheap defense against PID reuse). */
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
        const argv = cmd.split(/\s+/);
        const first = argv[0] ?? "";
        const isClaude = first === "claude" || /\/claude$/.test(first);
        const hasRc = argv.includes("remote-control") || argv.includes("--remote-control");
        if (!isClaude || !hasRc) continue;
      } catch {
        continue;
      }
      try {
        process.kill(pid, "SIGTERM");
        orphans++;
      } catch {
        /* already gone or permission denied; ignore */
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
    noSessionPersistence?: boolean;
    mcpDenyPatterns?: string[];
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
    noSessionPersistence: overrides?.noSessionPersistence,
    mcpDenyPatterns: overrides?.mcpDenyPatterns,
  };
}
