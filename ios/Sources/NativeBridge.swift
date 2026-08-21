import AVFoundation
import Foundation
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

    private let synthesizer = AVSpeechSynthesizer()
    private let impactLight = UIImpactFeedbackGenerator(style: .light)
    private let impactMedium = UIImpactFeedbackGenerator(style: .medium)
    private let notificationFeedback = UINotificationFeedbackGenerator()
    private let selectionFeedback = UISelectionFeedbackGenerator()

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
        case "selection": selectionFeedback.selectionChanged()
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
    }

    private func speak(_ params: [String: Any]) {
        if params["stop"] as? Bool == true {
            synthesizer.stopSpeaking(at: .immediate)
            return
        }
        guard let text = params["text"] as? String, !text.isEmpty else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
            ?? AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    private func noteVaultName(from health: [String: Any]) {
        guard let cwd = health["cwd"] as? String, !cwd.isEmpty else { return }
        let name = (cwd as NSString).lastPathComponent
        if !name.isEmpty, name != GatewayConfig.vaultName { GatewayConfig.vaultName = name }
    }

    // MARK: - Native → page

    func dispatch(_ name: String, _ payload: [String: Any] = [:]) {
        guard let webView,
              let nameData = try? JSONSerialization.data(
                  withJSONObject: name, options: [.fragmentsAllowed]),
              let nameJSON = String(data: nameData, encoding: .utf8),
              let payloadData = try? JSONSerialization.data(withJSONObject: payload),
              let payloadJSON = String(data: payloadData, encoding: .utf8)
        else { return }
        let script = "window.__vaultgw && window.__vaultgw.dispatch(\(nameJSON), \(payloadJSON))"
        webView.evaluateJavaScript(script)
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
