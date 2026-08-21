#if DEBUG
import Foundation
import WebKit

/// Launch-time automation seam. **DEBUG builds only**: the whole file is
/// compiled out of Release, so a shipped app cannot be pointed at another
/// gateway or made to send a turn by its environment.
///
/// Why it exists: a simulator has no Keychain to pre-seed, no clipboard worth
/// driving, and no way to type into a `WKWebView` without a human. Enrolling
/// the token by hand through the Settings sheet on every fresh install makes
/// end-to-end runs unrepeatable. `xcrun simctl` passes `SIMCTL_CHILD_*`
/// variables straight into the launched app's environment, so:
///
/// ```sh
/// SIMCTL_CHILD_VAULTGW_TOKEN="$(cat ~/.config/vault-gateway/token)" \
/// SIMCTL_CHILD_VAULTGW_HOST=100.96.112.74 \
/// SIMCTL_CHILD_VAULTGW_SCHEME=http \
/// SIMCTL_CHILD_VAULTGW_PORT=8788 \
/// xcrun simctl launch --terminate-running-process booted dev.henryortega.vaultgateway
/// ```
///
/// | Variable | Effect |
/// |---|---|
/// | `VAULTGW_TOKEN` | written to the Keychain (overwrites whatever is there) |
/// | `VAULTGW_HOST` | App Group `gatewayHost` |
/// | `VAULTGW_SCHEME` | `http` or `https` |
/// | `VAULTGW_PORT` | listen port |
/// | `VAULTGW_PERMISSION_MODE` | seeds the page's device settings before boot |
/// | `VAULTGW_AUTOSEND` | after the page loads, types this into the composer and presses Enter |
///
/// Values also read from launch arguments in `-VAULTGW_TOKEN value` form, which
/// is what an Xcode scheme's argument list produces.
enum DebugLaunchEnvironment {
    /// Seeds config from the environment. Called before anything reads it.
    static func applyIfPresent() {
        if let token = value("VAULTGW_TOKEN"), !token.isEmpty {
            GatewayConfig.setToken(token)
        }
        if let host = value("VAULTGW_HOST"), !host.isEmpty {
            GatewayConfig.host = host
            // An explicit host must not be shadowed by a stale IP override.
            GatewayConfig.suite.set("", forKey: GatewayConfig.Key.ipOverride)
        }
        if let scheme = value("VAULTGW_SCHEME"), scheme == "http" || scheme == "https" {
            GatewayConfig.scheme = scheme
        }
        if let port = value("VAULTGW_PORT"), let n = Int(port), n > 0 {
            GatewayConfig.port = n
        }
        if isActive {
            NSLog("[vaultgw][debug] launch env applied: \(GatewayConfig.scheme)://\(GatewayConfig.effectiveHost):\(GatewayConfig.port) token=\(GatewayConfig.hasToken)")
        }
    }

    /// True when any VAULTGW_* variable is set, i.e. this is an automated run.
    static var isActive: Bool {
        ["VAULTGW_TOKEN", "VAULTGW_HOST", "VAULTGW_SCHEME", "VAULTGW_PORT",
         "VAULTGW_PERMISSION_MODE", "VAULTGW_AUTOSEND"].contains { value($0) != nil }
    }

    /// Text to type into the composer and send, once, after the first load.
    static var autosend: String? { value("VAULTGW_AUTOSEND").flatMap { $0.isEmpty ? nil : $0 } }
    private static var autosendFired = false

    /// A `WKUserScript` that pre-seeds the page's device settings, or nil.
    /// Runs at document start, so `RemoteHost` reads it as if the user had
    /// picked the mode in the UI on a previous run.
    static func settingsSeedScript() -> WKUserScript? {
        guard let mode = value("VAULTGW_PERMISSION_MODE"), !mode.isEmpty else { return nil }
        let quoted = "\"\(mode.replacingOccurrences(of: "\"", with: ""))\""
        let source = """
        (function () {
          try {
            var key = "vaultgw.settings";
            var s = JSON.parse(window.localStorage.getItem(key) || "{}");
            s.permissionMode = \(quoted);
            window.localStorage.setItem(key, JSON.stringify(s));
          } catch (e) { /* storage disabled; the mode chip still works */ }
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// Fires `VAULTGW_AUTOSEND` once the page is up: inserts the text through
    /// the same `share` dispatch the iOS share sheet uses, then sends a
    /// synthetic Enter to the composer, which is what `InputBox` submits on.
    @MainActor
    static func autosendIfNeeded(bridge: NativeBridge) {
        guard !autosendFired, let text = autosend else { return }
        autosendFired = true
        bridge.dispatch("share", ["text": text])
        // The composer focuses itself on insert; give the layout a beat, then
        // press Enter on whatever textarea now holds focus.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            bridge.evaluate("""
            (function () {
              var ta = document.querySelector("textarea.claudian-input:not([style*='display: none'])")
                || document.activeElement;
              if (!ta || ta.tagName !== "TEXTAREA") return "no-composer";
              ta.focus();
              ta.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter", code: "Enter", keyCode: 13, which: 13,
                bubbles: true, cancelable: true
              }));
              return "sent";
            })();
            """)
        }
    }

    // MARK: - Command channel

    /// Polls `<app container>/Documents/debug-command.js` and evaluates
    /// whatever lands there in the page, then deletes it.
    ///
    /// The simulator on this machine cannot be driven with AppleScript: the
    /// Simulator app runs with no device window in this session, so there is
    /// nothing to click and `screencapture` comes back black, while
    /// `xcrun simctl io booted screenshot` still renders fine. Since every
    /// surface worth exercising (composer, mode chip, approval card, history)
    /// is web UI inside the WKWebView, a file the host can write is enough to
    /// drive the whole app:
    ///
    /// ```sh
    /// DIR=$(xcrun simctl get_app_container booted dev.henryortega.vaultgateway data)
    /// echo 'document.querySelector(".claudian-mode-chip").click()' > "$DIR/Documents/debug-command.js"
    /// ```
    @MainActor
    static func startCommandChannel(bridge: NativeBridge) {
        guard isActive, commandTimer == nil else { return }
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        else { return }
        let file = dir.appendingPathComponent("debug-command.js")
        NSLog("[vaultgw][debug] command channel: \(file.path)")
        commandTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            guard let js = try? String(contentsOf: file, encoding: .utf8),
                  !js.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return }
            try? FileManager.default.removeItem(at: file)
            NSLog("[vaultgw][debug] eval: \(js.prefix(120))")
            let out = dir.appendingPathComponent("debug-result.txt")
            Task { @MainActor in
                bridge.evaluate(js) { result, error in
                    let text: String
                    if let error { text = "ERROR: \(error.localizedDescription)" }
                    else if let result { text = String(describing: result) }
                    else { text = "undefined" }
                    try? text.write(to: out, atomically: true, encoding: .utf8)
                    NSLog("[vaultgw][debug] result: \(text.prefix(200))")
                }
            }
        }
    }

    private static var commandTimer: Timer?

    private static func value(_ name: String) -> String? {
        let info = ProcessInfo.processInfo
        if let v = info.environment[name] { return v }
        let args = info.arguments
        if let i = args.firstIndex(of: "-\(name)"), i + 1 < args.count { return args[i + 1] }
        return nil
    }
}
#endif
