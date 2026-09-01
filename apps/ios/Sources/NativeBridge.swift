import AVFoundation
import Foundation
import GameController
import UIKit
import WebKit

struct SafeAreaInsets: Equatable {
    var top: Double = 0
    var bottom: Double = 0
    var left: Double = 0
    var right: Double = 0

    var payload: [String: Any] { ["top": top, "bottom": bottom, "left": left, "right": right] }
}

/// The `native` message handler: every method in the CONTRACTS.md
/// "JS ↔ native bridge" table, plus the native → page `dispatch` side.
///
/// The page calls
/// `window.webkit.messageHandlers.native.postMessage({method, params})` and
/// awaits the promise; native never injects anything else into the page.
@MainActor
final class NativeBridge: NSObject, ObservableObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "native"

    weak var webView: WKWebView?
    var onOpenSettings: (() -> Void)?

    @Published private(set) var safeArea = SafeAreaInsets()

    /// Whether the page has finished loading at least once since the last
    /// (re)navigation. `evaluateJavaScript("window.__vaultgw && …")` is a
    /// no-op, not a queued call, when `__vaultgw` isn't defined yet — so a
    /// `dispatch` fired before the page's deferred script has run (the
    /// GeometryReader's very first safe-area push can beat page load; a
    /// content-process crash resets this to false until the reload's
    /// `didFinish` fires again) would otherwise vanish silently instead of
    /// reaching the page once it comes up. WebHost's Coordinator drives this
    /// via `markPageReady()` / `markPageNotReady()`.
    private var pageReady = false
    private var pendingDispatches: [(name: String, payload: [String: Any])] = []

    private let synthesizer = AVSpeechSynthesizer()
    private let impactLight = UIImpactFeedbackGenerator(style: .light)
    private let impactMedium = UIImpactFeedbackGenerator(style: .medium)
    private let notificationFeedback = UINotificationFeedbackGenerator()
    private let selectionFeedback = UISelectionFeedbackGenerator()

    override init() {
        super.init()
        synthesizer.delegate = self
        /* Hardware-keyboard presence, pushed to the page so the composer can
           switch Enter between newline (software keyboard) and submit
           (physical keyboard — Magic Keyboard, Smart Folio, Bluetooth).
           GCKeyboard is the only public API that reports attachment;
           `coalesced` is non-nil whenever any physical keyboard is connected.
           dispatch() queues until markPageReady, which also sends the
           then-current state, so a keyboard attached before page load is
           never missed. */
        NotificationCenter.default.addObserver(
            forName: .GCKeyboardDidConnect, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.pushHardwareKeyboardState() }
        }
        NotificationCenter.default.addObserver(
            forName: .GCKeyboardDidDisconnect, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.pushHardwareKeyboardState() }
        }
    }

    private func pushHardwareKeyboardState() {
        dispatch("hardwareKeyboard", ["present": GCKeyboard.coalesced != nil])
    }

    // MARK: - Page → native

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let dict = message.body as? [String: Any],
              let method = dict["method"] as? String
        else {
            replyHandler(nil, "bad_request")
            return
        }
        let params = dict["params"] as? [String: Any] ?? [:]
        Task { await self.handle(method: method, params: params, reply: replyHandler) }
    }

    private func handle(
        method: String,
        params: [String: Any],
        reply: @escaping (Any?, String?) -> Void
    ) async {
        switch method {
        case "getConfig":
            reply(configPayload(), nil)
        case "rpc":
            reply(await rpc(params), nil)
        case "wsUrl":
            reply(await wsUrl(), nil)
        case "haptic":
            haptic(kind: params["kind"] as? String ?? "light")
            reply(["ok": true], nil)
        case "openSettings":
            onOpenSettings?()
            reply(["ok": true], nil)
        case "setState":
            persistState(params)
            reply(["ok": true], nil)
        case "speak":
            speak(params)
            reply(["ok": true], nil)
        case "copy":
            UIPasteboard.general.string = params["text"] as? String ?? ""
            reply(["ok": true], nil)
        default:
            reply(nil, "unknown_method: \(method)")
        }
    }

    private func configPayload() -> [String: Any] {
        [
            "host": GatewayConfig.effectiveHost,
            "scheme": GatewayConfig.scheme == "https" ? "https" : "http",
            "port": GatewayConfig.port,
            "vaultName": GatewayConfig.vaultName,
            "hasToken": GatewayConfig.hasToken,
            "appVersion": GatewayConfig.appVersion,
            "theme": "dark",
            "safeArea": safeArea.payload,
        ]
    }

    private func rpc(_ params: [String: Any]) async -> [String: Any] {
        let path = params["path"] as? String ?? "/health"
        let method = params["method"] as? String ?? "GET"
        let body = params["body"]
        switch await GatewayClient.send(path: path, method: method, body: body) {
        case .http(let status, let data):
            var payload: [String: Any] = ["status": status]
            if data.isEmpty {
                payload["json"] = NSNull()
            } else if let json = try? JSONSerialization.jsonObject(
                with: data, options: [.fragmentsAllowed]
            ) {
                payload["json"] = json
                // Keep the vault name fresh for getConfig without a round trip.
                if path.hasPrefix("/health"), let dict = json as? [String: Any] {
                    noteVaultName(from: dict)
                }
            } else {
                payload["json"] = NSNull()
                payload["text"] = String(data: data, encoding: .utf8) ?? ""
            }
            return payload
        case .failure(let failure, let message):
            return ["status": 0, "error": failure.rawValue, "message": message]
        }
    }

    private func wsUrl() async -> [String: Any] {
        switch await GatewayClient.send(path: "/ws-ticket", method: "POST") {
        case .http(let status, let data):
            guard status == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ticket = json["ticket"] as? String
            else {
                return ["status": status, "error": status == 401 ? "unauthorized" : "no_ticket"]
            }
            return ["url": "\(GatewayConfig.webSocketOrigin)/ws/\(ticket)", "status": status]
        case .failure(let failure, let message):
            return ["status": 0, "error": failure.rawValue, "message": message]
        }
    }

    private func haptic(kind: String) {
        switch kind {
        case "medium": impactMedium.impactOccurred()
        case "success": notificationFeedback.notificationOccurred(.success)
        case "warning": notificationFeedback.notificationOccurred(.warning)
        case "error": notificationFeedback.notificationOccurred(.error)
        case "selection":
            selectionFeedback.selectionChanged()
            // Re-warm immediately: the Taptic Engine idles down after firing,
            // and without a `prepare()` standing by, the next selection tap
            // pays cold-start latency again.
            selectionFeedback.prepare()
        default: impactLight.impactOccurred()
        }
    }

    /// Persisted so `TurnNotifier` can arm a background `/wait` on the most
    /// recently busy tab after the page is gone.
    private func persistState(_ params: [String: Any]) {
        let suite = GatewayConfig.suite
        suite.set(params["activeTabId"] as? String ?? "", forKey: GatewayConfig.Key.activeTabId)
        suite.set(params["lastSeq"] as? [String: Int] ?? [:], forKey: GatewayConfig.Key.lastSeq)
        suite.set(params["busyTabs"] as? [String] ?? [], forKey: GatewayConfig.Key.busyTabs)
        // Not in the contract; the page may send it so notifications can name
        // the tab. Absent, notifications fall back to a generic body.
        if let titles = params["tabTitles"] as? [String: String] {
            suite.set(titles, forKey: GatewayConfig.Key.tabTitles)
        }
        // If a `.background` transition is waiting on this exact flush (the
        // post-`suspend` round trip) to arm the background `/wait`, this is
        // that flush landing — arm now instead of leaving it to the fallback
        // timer. No-op the rest of the time (every other setState call).
        TurnNotifier.shared.armIfPending()
    }

    private func speak(_ params: [String: Any]) {
        if params["stop"] as? Bool == true {
            synthesizer.stopSpeaking(at: .immediate)
            deactivateAudioSessionIfIdle()
            return
        }
        guard let text = params["text"] as? String, !text.isEmpty else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier(.bcp47))
            ?? AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    /// Releases the shared audio session once nothing is left to speak, so a
    /// completed or cancelled utterance doesn't leave another app's audio
    /// ducked for the rest of this app's lifetime.
    private func deactivateAudioSessionIfIdle() {
        guard !synthesizer.isSpeaking else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func noteVaultName(from health: [String: Any]) {
        guard let cwd = health["cwd"] as? String, !cwd.isEmpty else { return }
        let name = (cwd as NSString).lastPathComponent
        if !name.isEmpty, name != GatewayConfig.vaultName { GatewayConfig.vaultName = name }
    }

    // MARK: - Native → page

    func dispatch(_ name: String, _ payload: [String: Any] = [:]) {
        guard pageReady else {
            // Bounded for the same reason the JS-side queue in renderer.ts is:
            // native never sends a burst, so an unbounded queue during a
            // stuck/failed load would be a leak with no reader.
            if pendingDispatches.count < 32 { pendingDispatches.append((name, payload)) }
            return
        }
        rawDispatch(name, payload)
    }

    private func rawDispatch(_ name: String, _ payload: [String: Any]) {
        guard let webView,
              let nameData = try? JSONSerialization.data(
                  withJSONObject: name, options: [.fragmentsAllowed]),
              let nameJSON = String(data: nameData, encoding: .utf8),
              let payloadData = try? JSONSerialization.data(withJSONObject: payload),
              let payloadJSON = String(data: payloadData, encoding: .utf8)
        else { return }
        /* `switchTab` (a notification-tap deep link) deliberately bypasses
           `window.__vaultgw.dispatch`. That channel only starts draining once
           renderer.ts's boot() calls installHandler(), which sits behind
           several awaited gateway round trips (getConfig, /health, up to
           ~33s of waking a cold iCloud vault) — a tap landing in that window
           would hit the switch's `default: return` and vanish. It instead
           calls `window.__vaultgwSwitchTab`, which ios-web/src/native.ts
           defines at module-evaluation time — live before any of that async
           boot work starts, per CONTRACTS.md's native bridge section. Every
           other name is unaffected and still rides `dispatch`. */
        let script = name == "switchTab"
            ? "window.__vaultgwSwitchTab && window.__vaultgwSwitchTab(\(payloadJSON))"
            : "window.__vaultgw && window.__vaultgw.dispatch(\(nameJSON), \(payloadJSON))"
        webView.evaluateJavaScript(script)
    }

    /// Called once the page has actually loaded (WebHost's `didFinish`, which
    /// per the contract is after `renderer.js`'s deferred script has run and
    /// `window.__vaultgw` is guaranteed to exist). Flushes anything queued
    /// while the page was loading, in order.
    func markPageReady() {
        pageReady = true
        let pending = pendingDispatches
        pendingDispatches.removeAll()
        for item in pending { rawDispatch(item.name, item.payload) }
        /* A keyboard attached since before launch fires no connect
           notification, so seed the page with the current truth. Also
           deduplicates any queued connect/disconnect churn from the load
           window — last write wins on the JS side. */
        pushHardwareKeyboardState()
        // Warms the Taptic Engine ahead of the first tap; `selection` is the
        // only kind the page currently sends (ios-web/src/shell.ts).
        selectionFeedback.prepare()
    }

    /// Called when the page is about to go away and come back with fresh JS
    /// state (a content-process crash reload): the WKWebView instance is
    /// reused but `window.__vaultgw` has to be redefined from scratch, so
    /// dispatches between now and the next `markPageReady()` must queue again
    /// rather than firing into a page that hasn't re-run its module script.
    func markPageNotReady() {
        pageReady = false
    }

    /// Raw `evaluateJavaScript`. Only the DEBUG automation hook uses it; the
    /// contract's native → page direction is `dispatch`.
    func evaluate(_ script: String, completion: ((Any?, Error?) -> Void)? = nil) {
        guard let webView else {
            completion?(nil, nil)
            return
        }
        webView.evaluateJavaScript(script) { result, error in completion?(result, error) }
    }

    func updateSafeArea(_ insets: SafeAreaInsets) {
        guard insets != safeArea else { return }
        safeArea = insets
        dispatch("safeArea", insets.payload)
    }

    func dispatchConnectivity(_ state: ConnectivityState) {
        dispatch("connectivity", ["state": state.rawValue, "message": state.message])
    }
}

extension NativeBridge: AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        deactivateAudioSessionIfIdle()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        deactivateAudioSessionIfIdle()
    }
}
