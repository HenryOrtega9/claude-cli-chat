/* Header transparency slider.

   The panel floats above every other window, so how see-through it should be
   depends on what it is parked over. A header button opens a small popover
   with a range input. Only the BACKGROUND fades: the slider scales the CSS
   tint on #app and the container (desktop.css), while text stays fully
   opaque and picks up a dark halo as the tint thins, so it reads over
   whatever is behind. Every tick is also sent to the main process, which
   drops the macOS vibrancy blur below full level (a frosted backdrop is
   never see-through) and persists config.json's "opacity". Nothing is
   stored renderer-side: main is asked for the value at boot and on open.

   The popover carries the `claudesk-menu` class on purpose. renderer.ts's
   OVERLAY_SELECTOR includes it, so while the slider is up Escape closes the
   popover here instead of hiding the whole panel. */

import { ipcRenderer } from "electron";

/* Mirror main.ts's channel names and floor (separate bundles, no shared
   module). */
const IPC_SET_OPACITY = "claudesk:set-opacity";
const IPC_GET_OPACITY = "claudesk:get-opacity";
const MIN_PERCENT = 10;
const MIN_LEVEL = MIN_PERCENT / 100;
/* Same value as main.ts's VIBRANCY_THRESHOLD: the blur is on at and above it. */
const VIBRANCY_THRESHOLD = 0.85;
const DEFAULT_WASH = 0.6;
const DEFAULT_TINT = 0.4;

/* Paint the background for `level` in [0.1, 1].

   macOS vibrancy is on/off only, so the fade runs in two legs that meet at a
   fully opaque panel, where main flips the blur without a visible step:

   - [threshold, 1]: blur on. The #app wash thickens from its default 0.6 to
     1, covering the blur completely by the threshold. 100% is the original
     look exactly.
   - [0.1, threshold): blur off. Wash, container tint, and the header / tab
     row fill all scale together by one factor, from solid down to 10%.

   The halo stays off until the panel is clearly see-through, then ramps to
   full at the floor. */
function applyBackgroundLevel(level: number): void {
  const root = document.documentElement.style;
  if (level >= 1) {
    for (const name of ["--claudesk-wash", "--claudesk-tint", "--claudesk-chrome", "--claudesk-halo"]) {
      root.removeProperty(name);
    }
    return;
  }
  let wash: number;
  let tint: number;
  let chrome: number;
  if (level >= VIBRANCY_THRESHOLD) {
    const t = (1 - level) / (1 - VIBRANCY_THRESHOLD);
    wash = DEFAULT_WASH + (1 - DEFAULT_WASH) * t;
    tint = DEFAULT_TINT;
    chrome = 1;
  } else {
    const f = MIN_LEVEL + ((level - MIN_LEVEL) * (1 - MIN_LEVEL)) / (VIBRANCY_THRESHOLD - MIN_LEVEL);
    wash = f;
    tint = DEFAULT_TINT * f;
    chrome = f;
  }
  const halo = Math.min(1, Math.max(0, (0.8 - chrome) / 0.6));
  root.setProperty("--claudesk-wash", wash.toFixed(3));
  root.setProperty("--claudesk-tint", tint.toFixed(3));
  root.setProperty("--claudesk-chrome", chrome.toFixed(3));
  root.setProperty("--claudesk-halo", halo.toFixed(3));
}

async function readLevel(): Promise<number> {
  const reply: unknown = await ipcRenderer.invoke(IPC_GET_OPACITY);
  return typeof reply === "number" && Number.isFinite(reply) ? reply : 1;
}

/* Boot: restore the saved level before the user sees the panel. */
export async function restoreBackgroundLevel(): Promise<void> {
  try {
    applyBackgroundLevel(await readLevel());
  } catch (err) {
    console.warn("[claude-quick-chat] could not read background level:", err);
  }
}

let openPopover: { el: HTMLElement; close: () => void } | null = null;

export function toggleOpacityPopover(anchor: HTMLElement): void {
  if (openPopover) {
    openPopover.close();
    return;
  }
  void openOpacityPopover(anchor);
}

async function openOpacityPopover(anchor: HTMLElement): Promise<void> {
  const current = await readLevel();
  /* A second click can land while the invoke is in flight. */
  if (openPopover) return;

  const el = document.body.createDiv({ cls: "claudesk-menu claudesk-opacity-popover" });
  const head = el.createDiv({ cls: "claudesk-opacity-head" });
  head.createSpan({ text: "Background" });
  const readout = head.createSpan({ cls: "claudesk-opacity-value" });

  const slider = el.createEl("input", { type: "range" });
  slider.min = String(MIN_PERCENT);
  slider.max = "100";
  slider.step = "1";
  slider.value = String(Math.round(current * 100));
  slider.setAttribute("aria-label", "Panel background opacity");
  readout.setText(`${slider.value}%`);

  slider.addEventListener("input", () => {
    readout.setText(`${slider.value}%`);
    const level = Number(slider.value) / 100;
    applyBackgroundLevel(level);
    ipcRenderer.send(IPC_SET_OPACITY, level);
  });

  /* Below the button, right-aligned to it, kept inside the window. */
  const rect = anchor.getBoundingClientRect();
  el.style.top = `${Math.round(rect.bottom + 6)}px`;
  const width = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.round(rect.right - width))}px`;

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (target && (el.contains(target) || anchor.contains(target))) return;
    close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const close = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    el.remove();
    anchor.removeClass("is-active");
    if (openPopover?.el === el) openPopover = null;
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  anchor.addClass("is-active");
  openPopover = { el, close };
  slider.focus();
}
