# claude-cli-chat

An Obsidian plugin that turns the Claude Code CLI into a native chat UI inside the vault, plus the companion daemons that grew around it: an Apple Watch bridge and an LED matrix status display.

Each chat tab spawns its own `claude --print --output-format stream-json` subprocess and renders the event stream as chat bubbles, tool rows, and diffs. The plugin is the primary way I work with Claude Code against my Obsidian knowledge base. macOS only (Remote Control mode depends on Python `pty.fork`).

## Features

- **Chat UI in Obsidian**: streaming responses, tool-use rows, file diffs, cost pill per turn, session titles generated automatically.
- **Remote Control mode**: drives a full interactive `claude` session through a Python PTY proxy, so the plugin can host sessions that also accept input from claude.ai.
- **File pins**: attach vault files to a turn as one-shot or sticky context.
- **Model picker** with per-session model and effort selection.
- **MCP server management**: list the CLI's real MCP servers and disable them per vault via `--settings` deny rules at spawn.

## Companion daemons (`scripts/`)

### watch-bridge

`scripts/watch-bridge/bridge.py` is a zero-dependency Python daemon that holds one interactive `claude` session on a PTY and exposes it over a bearer-authed HTTP API on the Tailscale interface. It backs [ask-claude-watch](https://github.com/HenryOrtega9/ask-claude-watch), a standalone watchOS app. Endpoints cover chat turns with a partial-reply budget, a long-poll `/wait` for background notifications, a directory of every live Claude session on the Mac (with tmux input injection), and an OAuth usage proxy for plan-limit gauges.

### TC001 hardware status display

`scripts/animator.py` turns an Ulanzi TC001 (a 32x8 RGB LED matrix running the open [AWTRIX 3](https://blueforcer.github.io/awtrix3/) firmware) into a physical status light for Claude Code. A launchd daemon polls the plugin's state emitter every 300 ms and pushes hand-drawn frames over the device's HTTP API: distinct animations for thinking, tool use, awaiting approval, and done, with a walking-crab ambient when idle and a periodic battery readout.

Implementation notes: AWTRIX rejects payloads with more than ~100 draw items, so frames are run-length compressed from per-pixel `draw` calls into `df` rectangles before sending. `screens/preview.html` mirrors the animator's render logic pixel for pixel so animations can be designed in a browser before touching the device.

## Architecture

```
Obsidian (this plugin)            Apple Watch (ask-claude-watch)
   │  stream-json over stdio          │  HTTP over Tailscale
   ▼                                  ▼
claude CLI subprocess          watch-bridge daemon ── PTY ── interactive claude
   │                                  │
   └── StateEmitter ── animator.py ── TC001 LED matrix
```

Source layout:

- `src/main.ts`: plugin entry, chat view registration, plugin-wide singletons.
- `src/claude/`: everything that talks to the CLI (subprocess manager, stream-json parser, typed events).
- `src/ui/`: chat view, bubbles, settings tab.
- `scripts/`: the watch bridge, the TC001 animator, and their launchd plists.

## Build

```sh
npm install
npm run dev        # watch-mode esbuild
npm run build      # one-shot build into the vault plugin folder
npm run typecheck  # tsc --noEmit
```

Requires the [Claude Code CLI](https://claude.com/claude-code) on PATH and an active subscription or API key.

## License

MIT
