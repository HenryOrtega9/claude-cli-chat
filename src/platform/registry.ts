/* Module-level platform singleton.

   Why a singleton instead of injection: 18 shared files reference Obsidian
   APIs at arbitrary call depths, and threading a Platform through every
   constructor would change public signatures — which the migration rules
   forbid (parallel migration agents must not break each other's callers).
   A module-level `let` keeps every constructor unchanged; migrated code
   swaps `new Notice(x)` for `platform.notify(x)` mechanically.

   Initialization contract: main.ts calls initializePlatform() as the FIRST
   statement of onload(), before any view/engine/store code can run. Nothing
   in this repo touches `platform` at module-evaluation time (only inside
   methods/constructors invoked after onload), so the binding is always set
   by first use. The desktop shell will do the same with its own Platform
   before mounting any UI. */

import type { Platform } from "./types";

export let platform: Platform;

export function initializePlatform(p: Platform): void {
  platform = p;
}
