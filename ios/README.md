# Vault Gateway (iOS)

Native iOS shell for the vault gateway: a full-screen `WKWebView` that loads the
shared chat UI from the app bundle and hands it a native bridge for everything a
web page cannot do — the bearer token, the network calls, haptics, speech,
notifications, and a connectivity banner that survives the page failing to load.

The web UI itself is built elsewhere (`npm run build:ios` → `ios/Web/`). This
directory is only the shell. The contract between the two halves is
`docs/ios-gateway/CONTRACTS.md`, section "JS ↔ native bridge".

## Layout

```
ios/
  project.yml                    XcodeGen manifest — the authoritative project definition
  VaultGateway.xcodeproj         generated; committed so a clone opens without xcodegen
  Web/                           build output from `npm run build:ios` (gitignored)
  Sources/
    VaultGatewayApp.swift        @main, AppDelegate, root ZStack, scenePhase lifecycle
    WebHost.swift                UIViewRepresentable WKWebView + navigation delegate
    WebSchemeHandler.swift       serves vaultgw://app/... from the bundled Web folder
    NativeBridge.swift           the `native` message handler and the dispatch-to-page side
    GatewayClient.swift          HTTP transport, error classification, ConnectivityState
    GatewayConfig.swift          App Group defaults + Keychain token + URL building
    KeychainStore.swift          generic-password wrapper for the token
    ConnectivityMonitor.swift    /health probe on foreground and every 20 s
    ConnectivityBanner.swift     the native banner view
    SettingsView.swift           host / scheme / port / IP override / token / test
    TurnNotifier.swift           background /wait long-poll → local notifications
    DebugLaunchEnvironment.swift DEBUG only: VAULTGW_* launch hooks + a JS command channel
    ShareInbox.swift             reads what ShareExtension/ drops in the App Group container
    Secrets.example.swift        template for the gitignored Secrets.swift
    Info.plist                   generated from project.yml
    VaultGateway.entitlements    generated from project.yml (App Group)
  ShareExtension/                the Share Sheet target — see "Share Extension" below
    ShareViewController.swift    the entire extension: no storyboard, no compose UI
    Info.plist                   generated from project.yml (NSExtension dict)
    ShareExtension.entitlements  generated from project.yml (App Group only)
```

## Build

```sh
cp ios/Sources/Secrets.example.swift ios/Sources/Secrets.swift   # once
npm run build:ios                                                # fills ios/Web/
cd ios && xcodegen generate
xcodebuild -project ios/VaultGateway.xcodeproj -scheme VaultGateway \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet build
```

`ios/Web/` must exist before generating: it is a folder reference (blue folder),
so Xcode copies whatever is inside it into the bundle verbatim, and an absent
directory breaks the resources phase. Re-running `npm run build:ios` needs no
regeneration — the folder reference picks up new files on the next build.

### xcodegen is safe here, unlike ask-claude-watch

The watch app's README says never to run `xcodegen generate`, because its
`project.yml` predates the widget target and the app-group entitlement, so
regenerating would silently drop both. Nothing in this project is configured
outside `project.yml`: the target, the bundle id, the team, the App Group
entitlement, every Info.plist key and the `Web` folder reference are all
declared there, and both `Sources/Info.plist` and
`Sources/VaultGateway.entitlements` are generated from it. Regenerate freely;
never edit build settings in Xcode's inspector, since the next generate
overwrites them.

## Run

Simulator: build as above, then

```sh
xcrun simctl boot 'iPhone 17 Pro'
xcrun simctl install booted /path/to/VaultGateway.app
xcrun simctl launch booted dev.henryortega.vaultgateway
```

### On a device

Signing is automatic against team `SHMR9277Y3`; the bundle id
`dev.henryortega.vaultgateway` and the App Group are both declared in
`project.yml`, so no Xcode inspector work is needed. The same holds for
`ShareExtension` (bundle id `dev.henryortega.vaultgateway.share`) — verified
2026-08-21 with a no-device-attached build:

```sh
xcodebuild -project ios/VaultGateway.xcodeproj -scheme VaultGateway \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  -derivedDataPath <scratch dir> build
```

`BUILD SUCCEEDED`, and `codesign -d --entitlements :-` plus `security cms -D
-i embedded.mobileprovision` on the resulting
`VaultGateway.app/PlugIns/ShareExtension.appex` both showed a genuine device
profile: `application-identifier = SHMR9277Y3.dev.henryortega.vaultgateway.share`,
`com.apple.developer.team-identifier = SHMR9277Y3`, and
`com.apple.security.application-groups = [group.dev.henryortega.vaultgateway]`
— so the extension's bundle id and App Group are both registered on the paid
team and Xcode's automatic signing resolved a distinct profile for it (not
just inheriting the main app's). `-allowProvisioningUpdates` was not even
strictly exercised here (no new registration was needed — both identifiers
already existed on the account from `project.yml`'s prior generation), but
passing it is harmless and is what a genuinely first-time registration would
need.

From Xcode: open `VaultGateway.xcodeproj`, pick the phone, ⌘R.

From the command line, with the phone unlocked, on the same network and showing
`available` in `xcrun devicectl list devices`:

```sh
xcrun devicectl list devices                       # confirm state, copy the identifier
xcodebuild -project ios/VaultGateway.xcodeproj -scheme VaultGateway \
  -destination 'platform=iOS,name=Henry’s iPhone 17 Pro' -quiet build
xcrun devicectl device install app --device <identifier> /path/to/VaultGateway.app
xcrun devicectl device process launch --device <identifier> dev.henryortega.vaultgateway
```

A device listed as `unavailable` is paired but not reachable right now (locked,
asleep, off the network, or Developer Mode off). Unlock or plug it in and
re-run `devicectl list devices` rather than waiting on the build.

On a real phone use the tailnet FQDN, not the `100.x` IP: see "Networking and
ATS" below. The `VAULTGW_*` hooks are simulator-oriented (`SIMCTL_CHILD_*` is
how the values get in); on a device, enroll through Settings or seed
`Sources/Secrets.swift` before installing.

## Token enrollment

The gateway generates a 48-hex token on first run. On the Mac:

```sh
cat ~/.config/vault-gateway/token
```

Paste it into Settings → Token (the Paste button reads the clipboard directly),
then hit **Test connection**. The token is stored in the Keychain with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and is never synced to
iCloud; it survives an app uninstall, so use **Clear** to remove it for real.

With no token enrolled the app opens Settings automatically on first launch.

For repeat installs during development, `Sources/Secrets.swift` (gitignored)
can seed the host, port, and token so a fresh install lands connected. It only
seeds once per install; Settings owns every value afterwards.

### DEBUG launch hooks (simulator automation)

`Sources/DebugLaunchEnvironment.swift` is compiled **only into DEBUG builds**,
so a shipped app cannot be pointed at another gateway by its environment. It reads
`VAULTGW_*` from the process environment (or `-VAULTGW_NAME value` launch
arguments, which is what an Xcode scheme produces), and `xcrun simctl` forwards
anything prefixed `SIMCTL_CHILD_` into the launched app:

```sh
SIMCTL_CHILD_VAULTGW_TOKEN="$(cat ~/.config/vault-gateway/token)" \
SIMCTL_CHILD_VAULTGW_HOST=henrys-macbook-pro.tail92466c.ts.net \
SIMCTL_CHILD_VAULTGW_SCHEME=http \
SIMCTL_CHILD_VAULTGW_PORT=8788 \
xcrun simctl launch --terminate-running-process booted dev.henryortega.vaultgateway
```

| Variable | Effect |
|---|---|
| `VAULTGW_TOKEN` | written straight to the Keychain (overwrites) |
| `VAULTGW_HOST` | App Group `gatewayHost`; also clears a stale IP override |
| `VAULTGW_SCHEME` | `http` or `https` |
| `VAULTGW_PORT` | listen port |
| `VAULTGW_PERMISSION_MODE` | seeds `localStorage["vaultgw.settings"].permissionMode` at document start, so new tabs come up in that mode |
| `VAULTGW_AUTOSEND` | after the first page load, inserts the text through the same `share` dispatch the iOS share sheet uses, then presses Enter |

Setting any of them also flips the notification request to include
`.provisional`, which iOS grants without a prompt (quiet delivery, no banner).
An automated run has nobody to tap **Allow**, and an unanswered system alert
sits on top of every screenshot taken afterwards.

**Command channel.** While any `VAULTGW_*` is set, the app polls
`<data container>/Documents/debug-command.js` twice a second, evaluates whatever
lands there in the page, deletes it, and writes the result to
`debug-result.txt` beside it:

```sh
DIR=$(xcrun simctl get_app_container booted dev.henryortega.vaultgateway data)
echo 'document.querySelector(".claudian-mode-pill").click(); "ok"' > "$DIR/Documents/debug-command.js"
sleep 1 && cat "$DIR/Documents/debug-result.txt"
```

It exists because the Simulator app on this Mac can run with no device window:
AppleScript then finds zero windows and `screencapture` comes back black, while
`xcrun simctl io booted screenshot` still renders fine. Every surface worth
exercising (composer, mode chip, model picker, approval card, history) is web UI
inside the WKWebView, so a file the host can write drives the whole app. Useful
selectors: `textarea.claudian-input`, `.claudian-model-pill`,
`.claudian-mode-pill`, `.claudian-popup-row`, `.claudian-approval-btn-allow`,
`.claudian-tab-badge-new`.

## Networking and ATS

The gateway speaks plain HTTP inside the Tailscale WireGuard tunnel. Rather than
`NSAllowsArbitraryLoads` (which the watch app has to use because it talks to a
raw IP), the exception is scoped to one domain:

```
NSExceptionDomains → tail92466c.ts.net
  NSIncludesSubdomains, NSExceptionAllowsInsecureHTTPLoads
```

Consequence for the **IP override** field: ATS exception domains cannot name an
IP literal, and `NSAllowsLocalNetworking` only covers RFC 1918 / link-local
addresses, not the 100.64/10 CGNAT range Tailscale uses. So a raw `100.x` IP
works only with `scheme = https`. Leave the override empty and use the tailnet
FQDN, which is the default; the override is there for the case where MagicDNS is
misbehaving and you have TLS in front of the gateway (`tailscale serve`).

### HTTPS over Tailscale (deferred — one Henry-only admin-console click)

The app already prefers https automatically wherever it can: **Test connection**
in Settings probes `https://<host>` on the standard `tailscale serve --https=443`
port first, and only falls back to plain http if that fails. The moment the
https probe's response is recognizably THIS gateway — `GatewayClient.isGatewayResponse`
checks for `/health`'s own `{"state": "ready"|"starting", ...}` 200 shape, or
the exact `{"error":"unauthorized"}` 401 body a stale/missing token gets —
Settings flips itself to `scheme = https, port = 443` for you. Any other https
response on 443 (a captive portal, a TLS-intercepting proxy, an unrelated
service on the tailnet) falls through to http instead of hijacking Settings,
since a 200/302/404 that isn't shaped like `/health` proves nothing about who
answered. `GatewayClient.classify(_:)` also maps
a TLS/certificate failure (self-signed cert, no cert, expired cert) to its own
`tls_error` connectivity state with a dedicated banner message ("HTTPS
certificate problem — switch to HTTP in Settings, or fix the cert."), instead
of the generic "gateway isn't running" — see `GatewayClient.swift`
(`Failure.tlsError`, `probeHTTPS`/`probeHTTP`/`probePreferredScheme`) and
`ConnectivityState` (`tlsError` case).

What's still missing is the TLS cert itself. Checked 2026-08-21:

```sh
tailscale status --json | jq .CertDomains   # → null
tailscale serve status                      # → "No serve config"
tailscale cert henrys-macbook-pro.tail92466c.ts.net
# → 500 Internal Server Error: your Tailscale account does not support
#   getting TLS certs
```

HTTPS certs are a per-tailnet setting, off by default, and only the tailnet
admin can turn it on — a CLI agent cannot flip it. To enable it:

1. Open the [Tailscale admin console](https://login.tailscale.com/admin/dns) →
   **DNS** tab.
2. Under **HTTPS Certificates**, click **Enable HTTPS...** and confirm. (This
   is the one-click setting; it just needs a human logged into the account.)
3. Confirm it took: `tailscale status --json | jq .CertDomains` should list
   `henrys-macbook-pro.tail92466c.ts.net` instead of `null`.

Once that's on, front the plain-http gateway with a TLS-terminating `tailscale
serve` on the standard https port, bound loopback-only so nothing skips the
tailnet:

```sh
# VAULT_GATEWAY_BIND=127.0.0.1 (see scripts/gateway/src/config.ts) keeps the
# daemon off the tailnet interface directly; tailscale serve is what actually
# publishes it, TLS-terminated, to the tailnet.
tailscale serve --bg --https=443 http://127.0.0.1:8788
tailscale serve status   # should show the mapping and that a cert was issued
```

CONTRACTS.md already recorded that a WebSocket upgrade passes through a
`tailscale serve --http=8790 http://127.0.0.1:8788` proxy intact (no SSE
fallback needed); the same should hold for `--https=443`, but re-verify `wss://`
once serve is actually up — the daemon binds by `Host` header, so the tailnet
FQDN is required (a raw `100.x` IP 404s through serve, same as the plain-http
case).

Nothing else needs to change client-side once certs exist: the first **Test
connection** after that will see the https leg succeed and switch Settings
over on its own; the periodic `/health` poll and the WebSocket both already
read `GatewayConfig.scheme`/`.port`, which the switch just updated.

## Share Extension

A second target, `ShareExtension` (bundle id
`dev.henryortega.vaultgateway.share`, same team, same App Group), puts "Claude
& Second Brain" in the row that appears when text, a URL, or an image is
shared from another app (Safari's Share button, a Notes selection, a Photos
picker). `ios/ShareExtension/ShareViewController.swift` is the entire
extension — no storyboard, no compose box, just a "Saved. Open Claude &
Second Brain to send it." label while it works:

1. Reads `extensionContext.inputItems`' `NSItemProvider`s for a URL, plain
   text, and/or up to 4 images (`NSExtensionActivationRule` in `project.yml`).
   Images go through `loadFileRepresentation` + an ImageIO thumbnail decode
   (`CGImageSourceCreateThumbnailAtIndex` with
   `kCGImageSourceThumbnailMaxPixelSize`), not `UIImage(data:)` — a Share
   Extension's process budget is roughly 120MB, which a naive decode-then-
   redraw of a 48MP photo blows through before it ever reaches the resize.
   Downscaled to ≤2048px on the long edge, JPEG quality 0.82.
2. Writes one JSON manifest + zero or more `<uuid>-N.jpg` files into
   `ShareInbox/` inside the App Group container
   (`group.dev.henryortega.vaultgateway`), all sharing one UUID prefix so a
   second concurrent share (or a `ShareInbox.drain()` racing the write) can
   never observe a half-written unit — the manifest is written last and
   atomically, after every image file it references is already on disk.
3. Attempts a hand-off to the main app with
   `extensionContext.open(URL(string: "vaultgw-share://open")!)`, but does not
   depend on it succeeding — see "extensionContext.open is not reliable from a
   Share Extension" below.

`ios/Sources/ShareInbox.swift` (main-app target) is the reader.
`VaultGatewayApp.swift` calls `ShareInbox.drain(bridge:)` from three places —
`.onOpenURL` (the extension's best-effort hand-off, when it works), every
`.active` scenePhase transition (the guaranteed path: the app coming to the
foreground because the user switched back to it manually, independent of
whether `open(_:)` fired), and `WebHost`'s `onPageLoad` closure (a cold
launch's very first page load) — reading every `*.json` in `ShareInbox/`,
turning each into a `bridge.dispatch("share", payload)` call, and deleting the
files (plus a 60s-age orphan sweep for any stray image file left behind by a
process killed between writing an image and writing the manifest that
references it — see `ShareInbox.sweepOrphans`). `NativeBridge.dispatch` queues
automatically until the page has actually booted (`markPageReady()`), so
calling `drain` before the WKWebView exists is safe.

### extensionContext.open is not reliable from a Share Extension

Checked against Apple's own documentation and developer-forum reports
(2026-08-21, see the sources cited in `ShareViewController.finish`'s comment):
`NSExtensionContext.open(_:completionHandler:)` is documented as usable ONLY
from a Today (Notification Center) widget — Share Extensions are explicitly
excluded — and the documented alternative, `completeRequest`, does not open
the host app either. Multiple developers report the call silently no-oping
(completion handler returns `false`) from real Share Extensions. The classic
"walk the responder chain to something that responds to `openURL:`" trick does
not help either: it depends on a live `UIApplication` instance somewhere up
the chain, which only exists for extension types that share a process with a
host — a Share Extension is its own process with no `UIApplication` at all.

There is no Apple-sanctioned way for a Share Extension to launch its
containing app. Given that, the design here:
- Still calls `extensionContext.open(_:)` (cheap, harmless, occasionally
  reported to work) — see `ShareViewController.finish`.
- Does NOT promise delivery in the UI: the confirmation label reads "Saved.
  Open Claude & Second Brain to send it.", not "Sent to Claude" — see
  `ShareViewController.configureUI`.
- Treats `.active` as the guaranteed delivery path, not `.onOpenURL`. The App
  Group write happens synchronously before the label even shows, so the share
  is durably saved regardless of what `open(_:)` does; `ShareInbox.drain()`
  running on every foreground is what actually delivers it once the user
  reopens the app (themselves, or if `open(_:)` happens to work).

### Other things checked this pass

- **Manifest atomicity / a crash between image write and manifest write**:
  images are written (each `.atomic`) before the manifest, which is also
  `.atomic` and written last — `ShareInbox.drain()` only ever looks at
  `*.json` names, so a process killed after writing an image but before the
  manifest leaves that image behind with nothing to ever clean it up.
  `ShareInbox.sweepOrphans` (called at the end of every `drain()`) deletes any
  non-`.json` file in `ShareInbox/` older than 60s — old enough that a
  legitimate in-flight write (images land, manifest is a beat behind) can
  never be mistaken for a crash leftover.
- **Duplicate drain when `.onOpenURL` and `.active` both fire**: not a bug —
  `ShareInbox.drain` is synchronous (not `async`, no suspension points) and
  `@MainActor`, so two SwiftUI callbacks firing off the same launch event
  still run it to completion one after the other on the main thread, never
  interleaved; the manifest is also deleted before its dispatch fires, so
  even a literal double-invocation of `drain()` on the same directory listing
  would find nothing the second time.
- **A URL share with no text / multiple images / HEIC / oversized images**:
  read through `ShareViewController.processInputItems` and
  `loadDownscaledImage` — a URL share's `absoluteString` becomes `text`; up to
  4 images each get their own `DispatchGroup` entry; ImageIO's thumbnail
  generator (`CGImageSourceCreateThumbnailAtIndex`) decodes HEIC natively and
  every output is re-encoded to JPEG regardless of source format; the
  `kCGImageSourceCreateThumbnailFromImageAlways` + `ShouldCacheImmediately`
  options decode progressively at the target size rather than materializing a
  full-resolution bitmap first, which is what keeps a 48MP source inside the
  ~120MB extension budget. No changes needed here — already correctly
  engineered.
- **Cold launch losing the dispatch, not just for Share** (this predated this
  pass and is now fixed — see "Verified" below for how): `renderer.ts`'s
  `boot()` calls `installHandler(...)` — which flushes every dispatch queued
  while the page was loading, `share` included — *before* `await
  shell.mount()`, which is what actually builds the composer DOM. A `share`
  dispatch delivered during that window (always true on a cold launch: the
  WebKit IPC round-trip for `evaluateJavaScript` is far faster than `boot()`'s
  network calls that precede `installHandler`) used to silently no-op against
  an empty `#app`. Fixed by `IosChatShell.handleShare` (`ios-web/src/shell.ts`),
  which buffers into `pendingShare` when `mounted` is false and replays at the
  end of `mount()` — the same pattern `pendingSwitchTab` already used for a
  notification tap's deep link. `DebugLaunchEnvironment`'s `VAULTGW_AUTOSEND`
  hook rides the identical `share` dispatch channel, so it is fixed for free.

### Images now render as composer attachments

Wired end to end this pass:
- `ios-web/src/renderer.ts`'s `case "share"` now parses `payload.images` (a
  defensive `parseSharePayload`, dropping any malformed entry) alongside
  `payload.text` and calls `shell.handleShare({text, images})`.
- `IosChatShell.handleShare` / `applyShare` (`ios-web/src/shell.ts`) insert the
  text via the existing `insertIntoComposer` and, for images, call
  `InputBox.addImageAttachments` on the active tab's composer.
- `InputBox.addImageAttachments` (`src/view/InputBox.ts`) is the new public
  entry: strips the `data:...;base64,` prefix off each `dataUri` and pushes
  `{kind: "image", mediaType, data}` onto the same `attachments` array the +
  button and paste already use, so the resulting chip and the outgoing
  `ImageBlock` are identical either way.
- `IosChatShell.activeInputBox()` reaches `TabController`'s private
  `inputBox` field via a runtime (not compile-time) cast, documented inline as
  a deliberate stand-in: the clean fix is a one-line passthrough on
  `TabController` (`addImageAttachments(items) { this.inputBox.addImageAttachments(items); }`,
  next to the existing `ingestDroppedFiles`/`focusInput` passthroughs), but
  `TabController.ts` was another pass's file this wave (draft persistence /
  notification deep-link both touch it), so this reaches through instead of
  risking a concurrent write outside this pass's ownership. Worth landing the
  real passthrough as a follow-up.

**Verified** (`ios/build`, simulator `iPhone 17 Pro`, `xcodebuild -scheme
VaultGateway -destination 'platform=iOS Simulator,...' -derivedDataPath
ios/build build`, plus a throwaway isolated gateway instance per
`VAULT_GATEWAY_PORT`/`VAULT_GATEWAY_VAULT` so these could be checked without
the shared simulator's other concurrent traffic):
- `ShareExtension.appex` is embedded at
  `VaultGateway.app/PlugIns/ShareExtension.appex`, code-signed, bundle id
  `dev.henryortega.vaultgateway.share`; `NSExtensionPrincipalClass` resolves
  to `ShareExtension.ShareViewController`.
- Main app's `Info.plist` carries `CFBundleURLTypes` for `vaultgw-share://`.
- **Cold-launch text buffering, fixed**: a manifest hand-written into the App
  Group's `ShareInbox/` (matching exactly what the extension writes) while the
  app was fully terminated, then a genuine cold `simctl launch` — the text
  appeared in the composer on first render, and the manifest file was deleted
  from disk, confirming the drain-before-mount race no longer drops it.
- **Image attachment chip, confirmed**: the same cold-launch manifest with an
  attached JPEG produced a "JPEG attachment" chip in the composer alongside
  the text, both landing together through the new `pendingShare` buffer.
- **Image reaching Claude, confirmed at the wire level**: rather than fight
  the shared simulator's concurrent traffic for a UI-driven send, `POST
  /tabs/:id/turn` was called directly against the isolated gateway with the
  exact block shape `TabController.submit` builds from an image `Attachment`
  (`{type:"image", source:{type:"base64", media_type, data}}` + a text block).
  The turn completed and Claude's reply was "Terracotta" — the actual color of
  the test JPEG — proving the image bytes made it through decoded and seen by
  the model, not just accepted as opaque data. Since `addImageAttachments`
  produces the identical `Attachment` shape the existing paste/file-picker
  paths already use, and `TabController.submit`'s block-building code is
  unmodified, this closes the loop from composer chip to Claude's response.
- **Draft-preservation through a resync, confirmed** (a separate fix this same
  pass — `IosChatShell.resyncTab`, `ios-web/src/shell.ts`): `resyncTab` used
  to call `persistence.loadTab` (GET, server-authoritative `draft`) BEFORE
  `old.destroy()`, so even flushing right before destroy would already be too
  late — the GET's response can't retroactively include a flush that hadn't
  happened yet when it was sent. Fixed by reading the live textarea's value
  straight off `old.root` before destroy and, if it differs from the GET's
  `draft`, reapplying it to the new controller's textarea after `mountTab`
  (same `value` + `dispatchEvent(new Event("input", {bubbles: true}))`
  pattern `insertIntoComposer` uses). Verified with a genuine sub-500ms race:
  typed text and an externally-triggered `cleared` resync were fired from the
  same synchronous script (a page-side `fetch()` to `POST /tabs/:id/clear`
  issued in the same tick as the `input` event, well under the 500ms draft
  debounce) against the isolated gateway. The server's own persisted `draft`
  afterward was confirmed STALE (an earlier value, from before the debounce
  had a chance to fire), while the composer showed the exact just-typed text —
  proof it came from the new DOM-capture-and-reapply path, not from
  `fresh.draft`.
- **Not verified**: the real Safari/Notes → system share sheet → tap "Claude &
  Second Brain" flow. Driving the Simulator's UI needs Accessibility
  permission for the controlling process; `osascript` still fails with
  `-25211 ("not allowed assistive access")` in this sandboxed session (a
  different, further error than the `-25204` seen previously, but the same
  root cause: no Accessibility grant for this process). A human should do
  this once by hand: Safari → select text or just Share the page → **Claude &
  Second Brain** → confirm "Saved. Open Claude & Second Brain to send it."
  shows, then confirm reopening the app (manually, since `open(_:)` may not
  fire it) puts the text in the composer; repeat for an image share from
  Photos (expect: an attachment chip now, not the old silent no-op).
- **Also not verified initially — the generic device build's provisioning**:
  see "On a device" below for what running
  `xcodebuild ... -destination 'generic/platform=iOS' -allowProvisioningUpdates`
  actually showed for the `ShareExtension` target's bundle id and App Group
  registering on the paid team.

## Background turns

Backgrounding while a tab is busy arms a background `URLSession` long-poll
against `GET /wait?tab=…&since=…&timeout=600` (`TurnNotifier`, ported from the
watch app). The system finishes the download with the app suspended, relaunches
us through `application(_:handleEventsForBackgroundURLSession:)`, and the
delivered frame becomes a local notification: `turn_done` → "Claude finished",
`approval_request` → "Claude needs approval: <tool>" with Allow / Deny actions
that POST to `/tabs/:id/approve` straight from the notification. Local
notifications only; no APNs. The permission prompt appears the first time the
app actually reaches a connected state.

Which tab gets watched comes from the page's last `setState` call, so a page
that never calls `setState` gets no background notifications.

The whole path runs while the app is suspended, so there is nothing to watch
but the log:

```sh
xcrun simctl spawn booted log show --last 5m --info --debug \
  --predicate 'subsystem == "dev.henryortega.vaultgateway"' --style compact
```

`--info` is not optional: every line is `Logger.info`, and `log show` drops
info-level records without it. Expect `armed /wait …`, then
`wait delivered t=turn_done …`, then `notification posted: Claude finished`.
`arm skipped: busy=0` means the turn finished before the app backgrounded,
which is correct rather than a failure.
