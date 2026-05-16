/* Day-of-week and time-of-day greeting generator, ported from Claudian's
   MessageRenderer.ts logic so the welcome state feels identical. */

export function generateGreeting(userName: string, now: Date = new Date()): string {
  const hour = now.getHours();
  const day = now.getDay();
  const name = userName.trim();
  const personalize = (base: string, fallback?: string) => (name ? `${base}, ${name}` : (fallback ?? base));

  const dayGreetings: Record<number, string[]> = {
    0: [personalize("Happy Sunday"), "Sunday session?", "Welcome to the weekend"],
    1: [personalize("Happy Monday"), personalize("Back at it", "Back at it!")],
    2: [personalize("Happy Tuesday")],
    3: [personalize("Happy Wednesday")],
    4: [personalize("Happy Thursday")],
    5: [personalize("Happy Friday"), personalize("That Friday feeling")],
    6: [personalize("Happy Saturday"), personalize("Welcome to the weekend")],
  };

  const timeGreetings = (): string[] => {
    if (hour >= 5 && hour < 12) return [personalize("Good morning"), "Coffee time?"];
    if (hour >= 12 && hour < 18) return [personalize("Good afternoon"), personalize("Hey there")];
    if (hour >= 18 && hour < 22) return [personalize("Good evening"), personalize("Evening")];
    return ["Hello, night owl", personalize("Evening")];
  };

  const generalGreetings = [personalize("Hey there"), personalize("Hello"), personalize("Welcome back")];

  const pool = [...dayGreetings[day], ...timeGreetings(), ...generalGreetings];
  return pool[Math.floor(Math.random() * pool.length)];
}

/* Inlined base64-encoded Claude asterisk SVG, reused from the user's existing
   `claudian-icon.css` snippet. Provider color via fill="#D97757". */
/* Inner SVG content for registering the Claude asterisk as an Obsidian icon
   via `addIcon`. Obsidian wraps this in `<svg viewBox="0 0 100 100">`, so the
   path is scaled to fit that box. The `translate(-75.96,-223.53)` shifts the
   raw path coords into a 0-145 / 0-148 range; the `scale(0.676)` then maps
   that into the 0-100 icon box. `translate(1,0)` nudges it 1px right to
   center horizontally. `fill="currentColor"` lets Obsidian theme it
   (orange on hover, muted otherwise) like any other icon. */
export const CLAUDE_ASTERISK_ICON_SVG =
  `<g transform="translate(1,0) scale(0.676) translate(-75.96,-223.53)"><path fill="currentColor" d="m 105.01,322.07 29.14,-16.35 0.49,-1.42 -0.49,-0.79 h -1.42 l -4.87,-0.3 -16.65,-0.45 -14.44,-0.6 -13.99,-0.75 -3.52,-0.75 -3.3,-4.35 0.34,-2.17 2.96,-1.99 4.24,0.37 9.37,0.64 14.06,0.97 10.2,0.6 15.11,1.57 h 2.4 l 0.34,-0.97 -0.82,-0.6 -0.64,-0.6 -14.55,-9.86 -15.75,-10.42 -8.25,-6 -4.46,-3.04 -2.25,-2.85 -0.97,-6.22 4.05,-4.46 5.44,0.37 1.39,0.37 5.51,4.24 11.77,9.11 15.37,11.32 2.25,1.87 0.9,-0.64 0.11,-0.45 -1.01,-1.69 -8.36,-15.11 -8.92,-15.37 -3.97,-6.37 -1.05,-3.82 c -0.37,-1.57 -0.64,-2.89 -0.64,-4.5 l 4.61,-6.26 2.55,-0.82 6.15,0.82 2.59,2.25 3.82,8.74 6.19,13.76 9.6,18.71 2.81,5.55 1.5,5.14 0.56,1.57 h 0.97 v -0.9 l 0.79,-10.54 1.46,-12.94 1.42,-16.65 0.49,-4.69 2.32,-5.62 4.61,-3.04 3.6,1.72 2.96,4.24 -0.41,2.74 -1.76,11.44 -3.45,17.92 -2.25,12 h 1.31 l 1.5,-1.5 6.07,-8.06 10.2,-12.75 4.5,-5.06 5.25,-5.59 3.37,-2.66 h 6.37 l 4.69,6.97 -2.1,7.2 -6.56,8.32 -5.44,7.05 -7.8,10.5 -4.87,8.4 0.45,0.67 1.16,-0.11 17.62,-3.75 9.52,-1.72 11.36,-1.95 5.14,2.4 0.56,2.44 -2.02,4.99 -12.15,3 -14.25,2.85 -21.22,5.02 -0.26,0.19 0.3,0.37 9.56,0.9 4.09,0.22 h 10.01 l 18.64,1.39 4.87,3.22 2.92,3.94 -0.49,3 -7.5,3.82 -10.12,-2.4 -23.62,-5.62 -8.1,-2.02 h -1.12 v 0.67 l 6.75,6.6 12.37,11.17 15.49,14.4 0.79,3.56 -1.99,2.81 -2.1,-0.3 -13.61,-10.24 -5.25,-4.61 -11.89,-10.01 h -0.79 v 1.05 l 2.74,4.01 14.47,21.75 0.75,6.67 -1.05,2.17 -3.75,1.31 -4.12,-0.75 -8.47,-11.89 -8.74,-13.39 -7.05,-12 -0.86,0.49 -4.16,44.81 -1.95,2.29 -4.5,1.72 -3.75,-2.85 -1.99,-4.61 1.99,-9.11 2.4,-11.89 1.95,-9.45 1.76,-11.74 1.05,-3.9 -0.07,-0.26 -0.86,0.11 -8.85,12.15 -13.46,18.19 -10.65,11.4 -2.55,1.01 -4.42,-2.29 0.41,-4.09 2.47,-3.64 14.74,-18.75 8.89,-11.62 5.74,-6.71 -0.04,-0.97 h -0.34 l -39.15,25.42 -6.97,0.9 -3,-2.81 0.37,-4.61 1.42,-1.5 11.77,-8.1 -0.04,0.04 z"/></g>`;

export const CLAUDE_ASTERISK_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNDUgMTQ4Ij4KICA8cGF0aAogICAgZmlsbD0iI0Q5Nzc1NyIKICAgIHRyYW5zZm9ybT0idHJhbnNsYXRlKC03NS45NiwtMjIzLjUzKSIKICAgIGQ9Im0gMTA1LjAxLDMyMi4wNyAyOS4xNCwtMTYuMzUgMC40OSwtMS40MiAtMC40OSwtMC43OSBoIC0xLjQyIGwgLTQuODcsLTAuMyAtMTYuNjUsLTAuNDUgLTE0LjQ0LC0wLjYgLTEzLjk5LC0wLjc1IC0zLjUyLC0wLjc1IC0zLjMsLTQuMzUgMC4zNCwtMi4xNyAyLjk2LC0xLjk5IDQuMjQsMC4zNyA5LjM3LDAuNjQgMTQuMDYsMC45NyAxMC4yLDAuNiAxNS4xMSwxLjU3IGggMi40IGwgMC4zNCwtMC45NyAtMC44MiwtMC42IC0wLjY0LC0wLjYgLTE0LjU1LC05Ljg2IC0xNS43NSwtMTAuNDIgLTguMjUsLTYgLTQuNDYsLTMuMDQgLTIuMjUsLTIuODUgLTAuOTcsLTYuMjIgNC4wNSwtNC40NiA1LjQ0LDAuMzcgMS4zOSwwLjM3IDUuNTEsNC4yNCAxMS43Nyw5LjExIDE1LjM3LDExLjMyIDIuMjUsMS44NyAwLjksLTAuNjQgMC4xMSwtMC40NSAtMS4wMSwtMS42OSAtOC4zNiwtMTUuMTEgLTguOTIsLTE1LjM3IC0zLjk3LC02LjM3IC0xLjA1LC0zLjgyIGMgLTAuMzcsLTEuNTcgLTAuNjQsLTIuODkgLTAuNjQsLTQuNSBsIDQuNjEsLTYuMjYgMi41NSwtMC44MiA2LjE1LDAuODIgMi41OSwyLjI1IDMuODIsOC43NCA2LjE5LDEzLjc2IDkuNiwxOC43MSAyLjgxLDUuNTUgMS41LDUuMTQgMC41NiwxLjU3IGggMC45NyB2IC0wLjkgbCAwLjc5LC0xMC41NCAxLjQ2LC0xMi45NCAxLjQyLC0xNi42NSAwLjQ5LC00LjY5IDIuMzIsLTUuNjIgNC42MSwtMy4wNCAzLjYsMS43MiAyLjk2LDQuMjQgLTAuNDEsMi43NCAtMS43NiwxMS40NCAtMy40NSwxNy45MiAtMi4yNSwxMiBoIDEuMzEgbCAxLjUsLTEuNSA2LjA3LC04LjA2IDEwLjIsLTEyLjc1IDQuNSwtNS4wNiA1LjI1LC01LjU5IDMuMzcsLTIuNjYgaCA2LjM3IGwgNC42OSw2Ljk3IC0yLjEsNy4yIC02LjU2LDguMzIgLTUuNDQsNy4wNSAtNy44LDEwLjUgLTQuODcsOC40IDAuNDUsMC42NyAxLjE2LC0wLjExIDE3LjYyLC0zLjc1IDkuNTIsLTEuNzIgMTEuMzYsLTEuOTUgNS4xNCwyLjQgMC41NiwyLjQ0IC0yLjAyLDQuOTkgLTEyLjE1LDMgLTE0LjI1LDIuODUgLTIxLjIyLDUuMDIgLTAuMjYsMC4xOSAwLjMsMC4zNyA5LjU2LDAuOSA0LjA5LDAuMjIgaCAxMC4wMSBsIDE4LjY0LDEuMzkgNC44NywzLjIyIDIuOTIsMy45NCAtMC40OSwzIC03LjUsMy44MiAtMTAuMTIsLTIuNCAtMjMuNjIsLTUuNjIgLTguMSwtMi4wMiBoIC0xLjEyIHYgMC42NyBsIDYuNzUsNi42IDEyLjM3LDExLjE3IDE1LjQ5LDE0LjQgMC43OSwzLjU2IC0xLjk5LDIuODEgLTIuMSwtMC4zIC0xMy42MSwtMTAuMjQgLTUuMjUsLTQuNjEgLTExLjg5LC0xMC4wMSBoIC0wLjc5IHYgMS4wNSBsIDIuNzQsNC4wMSAxNC40NywyMS43NSAwLjc1LDYuNjcgLTEuMDUsMi4xNyAtMy43NSwxLjMxIC00LjEyLC0wLjc1IC04LjQ3LC0xMS44OSAtOC43NCwtMTMuMzkgLTcuMDUsLTEyIC0wLjg2LDAuNDkgLTQuMTYsNDQuODEgLTEuOTUsMi4yOSAtNC41LDEuNzIgLTMuNzUsLTIuODUgLTEuOTksLTQuNjEgMS45OSwtOS4xMSAyLjQsLTExLjg5IDEuOTUsLTkuNDUgMS43NiwtMTEuNzQgMS4wNSwtMy45IC0wLjA3LC0wLjI2IC0wLjg2LDAuMTEgLTguODUsMTIuMTUgLTEzLjQ2LDE4LjE5IC0xMC42NSwxMS40IC0yLjU1LDEuMDEgLTQuNDIsLTIuMjkgMC40MSwtNC4wOSAyLjQ3LC0zLjY0IDE0Ljc0LC0xOC43NSA4Ljg5LC0xMS42MiA1Ljc0LC02LjcxIC0wLjA0LC0wLjk3IGggLTAuMzQgbCAtMzkuMTUsMjUuNDIgLTYuOTcsMC45IC0zLC0yLjgxIDAuMzcsLTQuNjEgMS40MiwtMS41IDExLjc3LC04LjEgLTAuMDQsMC4wNCB6IgogIC8+Cjwvc3ZnPgo=";

export function renderWelcome(parent: HTMLElement, userName: string): HTMLElement {
  const welcome = parent.createDiv({ cls: "claudian-welcome" });
  const inner = welcome.createDiv({ cls: "claudian-welcome-inner" });

  const logo = inner.createDiv({ cls: "claudian-welcome-logo" });
  const img = logo.createEl("img");
  img.src = CLAUDE_ASTERISK_DATA_URI;
  img.alt = "Claude";

  inner.createDiv({
    cls: "claudian-welcome-greeting",
    text: generateGreeting(userName),
  });

  return welcome;
}

export function setWelcomeVisible(welcome: HTMLElement | null, visible: boolean) {
  if (!welcome) return;
  welcome.style.display = visible ? "" : "none";
}
