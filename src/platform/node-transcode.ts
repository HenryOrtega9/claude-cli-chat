/* Node-backed image transcode for the two macOS hosts (Obsidian plugin and
   Electron shell). Chromium cannot decode HEIC/HEIF, so the canvas path in
   InputBox.toApiImage fails there and falls through to this: `sips`, which
   ships with macOS and reads every format Photos can produce, round-trips
   the bytes through a temp file into a JPEG.

   Kept in its own module (instead of node-capabilities.ts) so the Platform
   implementations can import it without dragging the engine-side classes
   node-capabilities pulls in. Only node builtins here — the iOS web bundle
   must never import this file (forbidNodeImports enforces that). */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function transcodeImageToJpeg(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  if (process.platform !== "darwin") return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "claude-cli-chat-img-"));
    /* sips keys off the extension for the INPUT sniff as well as the output
       format, but tolerates a wrong one — the container is sniffed. A best
       guess keeps its warnings quiet. */
    const ext = mediaType === "image/heif" ? "heif" : mediaType.split("/")[1] || "img";
    const src = join(dir, `in.${ext}`);
    const out = join(dir, "out.jpg");
    await writeFile(src, bytes);
    const ok = await new Promise<boolean>(resolve => {
      const child = spawn("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", src, "--out", out], {
        stdio: "ignore",
      });
      child.on("error", () => resolve(false));
      child.on("close", code => resolve(code === 0));
    });
    if (!ok) return null;
    return { bytes: new Uint8Array(await readFile(out)), mediaType: "image/jpeg" };
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
