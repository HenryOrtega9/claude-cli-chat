# Integration: the app running end to end

Wave 3. The three halves built in parallel (`shared-ui`, `gateway`, `ios-shell`,
then `ios-web`) put together and driven as one product: the daemon under
launchd, the native shell installed on an iPhone 17 Pro simulator, and the
shared chat UI talking to the Mac's vault over Tailscale.

Contract: [`CONTRACTS.md`](CONTRACTS.md). Browser client: [`WAVE2.md`](WAVE2.md).

## What was verified

Against the launchd daemon at `henrys-macbook-pro.tail92466c.ts.net:8788`, vault
`Henry Ortega's Second Brain`, from a Debug build on the iPhone 17 Pro simulator
(iOS 26.3).

| | Result |
|---|---|
| Gateway rebuild + `launchctl kickstart` | `/health` → `ready`, WebSocket handshake accepted by WKWebView (the wave-1 GUID typo is really gone) |
| `daemons/gateway/test/smoke.mjs` | 34/34 assertions, including the new cold-tab regression |
| Cold launch, token seeded, no banner | [`sim-01`](screens/sim-01-welcome.png) |
| Streamed turn | [`sim-02`](screens/sim-02-streamed-reply.png) |
| Approval card in `default` mode | [`sim-03`](screens/sim-03-approval-card.png) |
| Allow → tool row, result, answer | [`sim-04`](screens/sim-04-tool-result.png) |
| Backgrounded mid-turn → local notification | [`sim-05`](screens/sim-05-background-notification.png) + `os_log` |
| Foreground → reply present, no duplicate, scrolled to it | [`sim-06`](screens/sim-06-foreground-after-background.png) |
| Kill + relaunch → tabs and the active tab restore | [`sim-07`](screens/sim-07-restored-tabs.png) |
| Gateway stopped → "The vault gateway isn't running." | [`sim-08`](screens/sim-08-gateway-down.png) |
| Gateway restarted → banner clears, page self-heals (< 20 s) | [`sim-09`](screens/sim-09-gateway-recovered.png) |

Safe areas hold in every state: the header clears the Dynamic Island (including
with the keyboard up, which used to drag it under), the composer sits above the
home indicator and above the keyboard, and the boot-error screen clears both the
island and the native banner.

**Device:** not installed. `xcrun devicectl list devices` reported Henry's
iPhone 17 Pro as `unavailable` (paired, not reachable) for the whole session, so
the device leg is untested. Steps are in [`../../ios/README.md`](../../ios/README.md).

## Bugs found and fixed

### Gateway

1. **A rehydrated tab that never ran spawned `--resume`** (the wave-1 known bug).
   `engine.ts` marked every restored tab `sessionEstablished`, so a tab created
   by `POST /tabs` and not used before a restart resumed a conversation the CLI
   had never created: exit 1, `error_during_execution`, forever. `canResume()`
   now answers from evidence (this process saw `system/init`, or a transcript
   exists at `~/.claude/projects/<slug>/<sessionId>.jsonl`), and a `--resume`
   child that dies before `system/init` is retried once with `--session-id` and
   the same blocks (nothing streamed, so the retry is invisible).
   `smoke.mjs` section 7 is the regression.
2. **A never-used tab vanished on restart.** `restore()` skips index entries
   with no conversation file, and nothing wrote one at creation. `TabEngine`
   now persists a new tab immediately.
3. **Model / effort / mode changes could silently not apply.** Those are argv, so
   a live child cannot honor them. The client's `dispose()` → `/abort` covered
   the case where the client held a session, but a page that had just reloaded
   holds none, so it PATCHed, the daemon kept the old child, and the next turn
   ran on the old model. `patch()` now drops the child itself (immediately when
   idle, at the next turn otherwise, via `await engine.prepareForTurn()`).
4. **A replaced child's trailing events hit the tab that replaced it.** The
   session listeners had no identity guard, so an ungated `onExit` nulled out
   the successor session. Guarded, which is what made (3) safe.
5. **Restored conversations rendered tool rows after the answer they produced.**
   The projection folded a whole turn into one bubble; the live client starts a
   new bubble per API `message.id`. The daemon tracks the id now, so re-reading a
   conversation from disk looks like watching it happen.

### iOS shell

6. **Background turns never notified.** `GET /wait` answers `{frame, lastSeq}`;
   `TurnNotifier` read `t` off the envelope (the watch bridge it was ported from
   returns a bare frame), found nothing, and posted nothing: the exact symptom
   the feature exists to prevent. It unwraps `frame` now, and accepts a bare
   frame too. `os_log` lines were added along the whole path, since it runs while
   the app is suspended.
7. **The connectivity banner covered the page header.** It is a native view over
   the web view; its height is now folded into the safe-area top inset the page
   receives, so the header moves down instead of disappearing behind it.

### Web client

8. **The keyboard dragged the header under the Dynamic Island.** WebKit scrolls
   the layout viewport to reveal a focused input even when the document cannot
   scroll, and that scroll landed in `visualViewport.offsetTop`, where the old
   inset formula subtracted it and computed a keyboard inset of 0. The scroll is
   pinned back to the top and the inset is measured as `innerHeight - vv.height`.
9. **Message action pills overlapped the next row.** `@media (hover: none)`
   reserved 30px for a pill that is 46px tall once `(pointer: coarse)` applies
   its 40px touch minimum. Reserve is 52px.
10. **Connectivity was stated twice.** The page's inline strip repeated the
    native banner's sentence verbatim, stacked under it. Under the native host
    the strip now only shows what native cannot see (a reconnecting socket over
    a healthy tunnel); the dev browser, which has no banner, keeps it.
11. **A failed boot never recovered.** `renderBootError` was terminal, so a
    phone that opened while the Mac was asleep stayed on the error screen after
    the Mac came back. It now reloads on native's `connectivity: ok`, on
    `resume`, or on its own 10 s `/health` poll.
12. **Scroll stickiness died in the background.** A hidden document reports
    every element as not intersecting, which `MessageRenderer` read as "the user
    scrolled away", so the reply that arrived while the app was backgrounded
    sat below the fold on return. The observer ignores callbacks while
    `document.visibilityState === "hidden"` (a fix for the plugin and desktop
    app too, where a hidden tab did the same thing).

## Known gaps

- **No device run.** See above.
- **Notification banners are not visually verified.** Automated launches take
  `.provisional` authorization (nobody can tap **Allow** in a headless
  simulator), which delivers quietly to Notification Center. Delivery is proven
  by `notification posted: Claude finished` in `os_log`, not by a screenshot.
  The Allow / Deny actions on an `approval_request` notification were not
  exercised for the same reason.
- **The default model is unusable on this account right now.** New tabs come up
  on Sonnet 4.6 1M (the shared `DEFAULT_SETTINGS.defaultModel`), and every 1M
  model returns `API Error: Usage credits required for 1M context` while the
  credit pool is empty, visible in [`sim-07`](screens/sim-07-restored-tabs.png).
  This is the account, not the app, and the desktop clients share the default;
  the phone just meets it first. Switching the pill to Haiku or Opus Plan works.
- **Simulator automation is a debug-only seam.** The `VAULTGW_*` hooks and the
  `debug-command.js` channel exist because the Simulator app on this Mac runs
  with no device window (AppleScript sees zero windows, `screencapture` is
  black). They are compiled out of Release; a device run needs Settings or
  `Secrets.swift`.
- **Voice, incognito, history and the MCP manager were exercised by wave 2 in
  the dev browser, not re-run here.** Nothing in this pass touched them.
- Two test chats ("Ping Pong Response Test", "Testing simple AI instruction
  compliance") are left in `<vault>/.claude-cli-chat/ios/`; delete them from the
  app's history if they are in the way.
