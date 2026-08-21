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

Device: open `VaultGateway.xcodeproj`, pick the phone, ⌘R. Signing is automatic
against team `SHMR9277Y3`.

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
