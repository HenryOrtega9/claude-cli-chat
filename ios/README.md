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
    Secrets.example.swift        template for the gitignored Secrets.swift
    Info.plist                   generated from project.yml
    VaultGateway.entitlements    generated from project.yml (App Group)
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
`project.yml`, so no Xcode inspector work is needed.

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
