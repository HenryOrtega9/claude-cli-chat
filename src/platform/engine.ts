/* The chat engine surface shared code is allowed to see.

   `PluginHost.subprocessManager` used to be typed as the concrete
   `SubprocessManager` class, which drags `node:child_process` (and the whole
   spawn/PTY stack) into every module that so much as reads the host type.
   That is fine for the Obsidian plugin and the Electron shell — both run with
   node in the renderer — but the iOS client renders the same view layer in a
   plain browser, where the engine lives on the other end of a WebSocket.

   These interfaces are EXACTLY the members TabController touches, nothing
   more. `SubprocessManager` / `TabSession` satisfy them structurally (see the
   `satisfies`-style assertions at the bottom of SubprocessManager.ts), so
   every existing call site keeps compiling and behavior is unchanged; a
   remote engine only has to implement this much.

   IMPORT DISCIPLINE: type-only imports exclusively, same rule as ./host.ts.
   `import type` is erased at emit, so nothing here creates a runtime edge to
   a node-backed module. Do not add value imports. */

import type { StreamEvent, ContentBlock, ControlRequestEvent } from "../claude/Events";
import type { RemoteStatus } from "../claude/RemoteControlSession";
import type { SpawnOptions, TabSessionStatus } from "../claude/SubprocessManager";

/* Re-exported so browser-side code has a single node-free import site for the
   engine vocabulary. Type-only re-exports are erased at emit. */
export type { SpawnOptions, TabSessionStatus } from "../claude/SubprocessManager";
export type { StreamEvent, ContentBlock, ControlRequestEvent } from "../claude/Events";
export type { RemoteStatus } from "../claude/RemoteControlSession";

/* The member surface of TabSession that TabController uses. */
export interface TabSessionLike {
  /* Assigned by the engine once the CLI's init event names the session. */
  sessionId: string | null;
  status: TabSessionStatus;
  readonly pid: number | undefined;

  sendUserText(text: string): void;
  sendUserContent(blocks: ContentBlock[]): void;
  approve(requestId: string, updatedInput?: Record<string, unknown>): void;
  deny(requestId: string, reason?: string): void;
  getPendingApprovals(): ControlRequestEvent[];
  isTerminal(): boolean;
  dispose(): Promise<void>;

  onEvent(cb: (e: StreamEvent) => void): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(cb: (err: Error) => void): void;
  onStderr(cb: (chunk: string) => void): void;
}

/* The member surface of RemoteControlSession that TabController (and
   SubprocessManager.registerRemote) use. */
export interface RemoteControlSessionLike {
  status: RemoteStatus;
  url: string | null;
  sessionFile: string | null;
  onUrl(cb: (url: string) => void): void;
  onStatus(cb: (status: RemoteStatus) => void): void;
  onSessionFile(cb: (path: string) => void): void;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number | null) => void): void;
  dispose(): Promise<void>;
}

/* The member surface of SubprocessManager that TabController uses. The
   remote/session-file members are here because a Remote Control tab hands its
   session to the manager for reaping and claim coordination. */
export interface SubprocessManagerLike {
  spawn(tabId: string, opts: SpawnOptions): TabSessionLike;
  registerRemote(tabId: string, session: RemoteControlSessionLike): void;
  unregisterRemote(tabId: string): void;
  claimSessionFile(path: string): boolean;
  isSessionFileClaimed(path: string): boolean;
}
