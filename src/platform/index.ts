/* Platform module public surface.

   Shared code imports EVERYTHING platform-related from here:

     import { platform, PlatformModal, type FileStorage } from "../platform";

   Deliberately NOT re-exported: ./obsidian (the Obsidian implementation).
   Only main.ts may import that, directly from "./platform/obsidian" — this
   module must stay importable in a build that doesn't ship the obsidian
   package at all. ./host is also imported directly ("../platform/host") to
   keep this module's runtime footprint at exactly types + registry + modal
   bases. */

export * from "./types";
export { platform, initializePlatform } from "./registry";
export { PlatformModal, PlatformSuggestModal } from "./modals";
