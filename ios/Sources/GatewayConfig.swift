import Foundation
import SwiftUI

/// Gateway connection settings.
///
/// Ported from ask-claude-watch/Sources/BridgeConfig.swift: same App Group
/// UserDefaults pattern so a future widget/extension reads exactly what the
/// Settings sheet writes. Differences from the watch: a scheme (http|https), a
/// raw-IP override, and the token moved out of UserDefaults into the Keychain.
enum GatewayConfig {
    static let appGroup = "group.dev.henryortega.vaultgateway"
    static let suite = UserDefaults(suiteName: GatewayConfig.appGroup) ?? .standard

    static let builtInHost = "henrys-macbook-pro.tail92466c.ts.net"
    static let builtInScheme = "http"
    static let builtInPort = 8788
    static let tokenAccount = "gatewayToken"

    // Keys shared with SettingsView's own @AppStorage bindings.
    enum Key {
        static let host = "gatewayHost"
        static let scheme = "gatewayScheme"
        static let port = "gatewayPort"
        static let ipOverride = "gatewayIPOverride"
        static let webInspector = "gatewayWebInspector"
        static let vaultName = "gatewayVaultName"
        static let seeded = "gatewaySecretsSeeded"
        // Written by the `setState` bridge method, read when arming /wait.
        static let activeTabId = "stateActiveTabId"
        static let lastSeq = "stateLastSeq"
        static let busyTabs = "stateBusyTabs"
        static let tabTitles = "stateTabTitles"
    }

    @AppStorage(Key.host, store: GatewayConfig.suite)
    static var host: String = GatewayConfig.builtInHost

    @AppStorage(Key.scheme, store: GatewayConfig.suite)
    static var scheme: String = GatewayConfig.builtInScheme

    @AppStorage(Key.port, store: GatewayConfig.suite)
    static var port: Int = GatewayConfig.builtInPort

    /// Optional raw tailnet IP (100.x). Wins over `host` when non-empty.
    /// ATS cannot scope an exception to an IP literal, so this only works over
    /// https or with ATS otherwise satisfied — see ios/README.md.
    @AppStorage(Key.ipOverride, store: GatewayConfig.suite)
    static var ipOverride: String = ""

    @AppStorage(Key.webInspector, store: GatewayConfig.suite)
    static var webInspectorEnabled: Bool = false

    /// Last vault basename seen from `/health.cwd`, surfaced to the page in
    /// `getConfig` so it can title itself before the first RPC lands.
    @AppStorage(Key.vaultName, store: GatewayConfig.suite)
    static var vaultName: String = ""

    static var effectiveHost: String {
        let override = ipOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        return override.isEmpty ? host.trimmingCharacters(in: .whitespacesAndNewlines) : override
    }

    static var token: String { KeychainStore.read(tokenAccount) ?? "" }

    static var hasToken: Bool { !token.isEmpty }

    static func setToken(_ value: String) {
        KeychainStore.write(tokenAccount, value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func url(_ path: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme == "https" ? "https" : "http"
        components.host = effectiveHost
        components.port = port
        guard let base = components.url else { return nil }
        return URL(string: path, relativeTo: base)?.absoluteURL
    }

    /// `ws(s)://host:port` prefix for `wsUrl`.
    static var webSocketOrigin: String {
        let wsScheme = scheme == "https" ? "wss" : "ws"
        return "\(wsScheme)://\(effectiveHost):\(port)"
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    /// First-launch seed from the gitignored Secrets.swift. Runs once; after
    /// that Settings owns every value. Migration: none (v1).
    static func seedFromSecretsIfNeeded() {
        guard !suite.bool(forKey: Key.seeded) else { return }
        suite.set(true, forKey: Key.seeded)
        if !Secrets.gatewayHost.isEmpty { host = Secrets.gatewayHost }
        if Secrets.gatewayPort > 0 { port = Secrets.gatewayPort }
        if !Secrets.gatewayToken.isEmpty, !hasToken { setToken(Secrets.gatewayToken) }
    }
}
