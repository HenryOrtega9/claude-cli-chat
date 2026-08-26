import SwiftUI
import UIKit

/// Connection settings sheet.
///
/// Shape follows ask-claude-watch/Sources/SettingsView.swift (a Form, a Test
/// connection button that hits /health and reports what came back), with the
/// token moved to a SecureField backed by the Keychain rather than
/// UserDefaults.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    var onClose: () -> Void

    @AppStorage(GatewayConfig.Key.host, store: GatewayConfig.suite)
    private var host = GatewayConfig.builtInHost
    @AppStorage(GatewayConfig.Key.scheme, store: GatewayConfig.suite)
    private var scheme = GatewayConfig.builtInScheme
    @AppStorage(GatewayConfig.Key.port, store: GatewayConfig.suite)
    private var port = GatewayConfig.builtInPort
    @AppStorage(GatewayConfig.Key.ipOverride, store: GatewayConfig.suite)
    private var ipOverride = ""
    @AppStorage(GatewayConfig.Key.webInspector, store: GatewayConfig.suite)
    private var webInspector = false

    @State private var token = ""
    @State private var status = ""
    @State private var testing = false

    /// Mirrors the range `GatewayConfig.url(_:)` now enforces. A port outside
    /// it (in particular a negative one, which used to crash the app the
    /// instant the next health probe built a URL from it — `URLComponents`'s
    /// port setter traps rather than failing gracefully) must never leave
    /// this screen silently accepted.
    private var isPortValid: Bool { (1...65535).contains(port) }
    private var isHostValid: Bool { !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var isConfigValid: Bool { isPortValid && isHostValid }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Host") {
                        TextField("host.tailnet.ts.net", text: $host)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                    }
                    Picker("Scheme", selection: $scheme) {
                        Text("http").tag("http")
                        Text("https").tag("https")
                    }
                    LabeledContent("Port") {
                        TextField("8788", value: $port, format: .number.grouping(.never))
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(isPortValid ? Color.primary : Color.red)
                    }
                } header: {
                    Text("Gateway")
                } footer: {
                    if !isHostValid {
                        Text("Host can't be empty.").foregroundStyle(.red)
                    } else if !isPortValid {
                        Text("Port must be between 1 and 65535.").foregroundStyle(.red)
                    }
                }

                Section {
                    LabeledContent("IP override") {
                        TextField("100.x.y.z", text: $ipOverride)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.numbersAndPunctuation)
                            .multilineTextAlignment(.trailing)
                    }
                } footer: {
                    Text("Optional raw tailnet IP; wins over Host when set. App Transport Security cannot except an IP literal, so a raw IP works only over https. Leave empty to use the Tailscale hostname.")
                }

                Section {
                    SecureField("Bearer token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(saveToken)
                    HStack {
                        Button("Paste") {
                            token = (UIPasteboard.general.string ?? token)
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            saveToken()
                        }
                        Spacer()
                        Button("Clear", role: .destructive) {
                            token = ""
                            saveToken()
                        }
                        .disabled(token.isEmpty)
                    }
                } header: {
                    Text("Token")
                } footer: {
                    Text("On the Mac: cat ~/.config/vault-gateway/token. Stored in the Keychain, this device only.")
                }

                Section {
                    Button(testing ? "Testing…" : "Test connection", action: testConnection)
                        .disabled(testing || !isConfigValid)
                    if !status.isEmpty {
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Developer") {
                    Toggle("Web inspector", isOn: $webInspector)
                    LabeledContent("Version", value: GatewayConfig.appVersion)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        saveToken()
                        dismiss()
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .onAppear { token = GatewayConfig.token }
        .onDisappear {
            saveToken()
            onClose()
        }
    }

    private func saveToken() {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != GatewayConfig.token else { return }
        GatewayConfig.setToken(trimmed)
    }

    /// https-first: probes `https://<host>` on the standard `tailscale serve
    /// --https=443` port before falling back to the stored http port. If the
    /// https leg gets any real HTTP response back (proof the TLS layer
    /// works, independent of auth), Settings switches itself to https/443 —
    /// "a Settings toggle default of https when the probe succeeds". Tailscale
    /// TLS certs are not enabled for this tailnet as of 2026-08-21
    /// (`tailscale cert` → "your Tailscale account does not support getting
    /// TLS certs"; `CertDomains` is null in `tailscale status --json`), so in
    /// practice this always falls through to http today — see ios/README.md.
    private func testConnection() {
        saveToken()
        testing = true
        status = "Testing…"
        Task {
            let result = await GatewayClient.probePreferredScheme()
            let state = ConnectivityState.from(result.outcome)
            let schemeLabel = result.scheme.uppercased()
            switch result.outcome {
            case .http(let code, let data):
                if code == 200 {
                    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    let gatewayState = json?["state"] as? String ?? "ready"
                    var line = "Connected via \(schemeLabel). Gateway is \(gatewayState)."
                    if let cwd = json?["cwd"] as? String, !cwd.isEmpty {
                        line += " Vault: \((cwd as NSString).lastPathComponent)."
                    }
                    status = line
                } else {
                    status = "\(schemeLabel) HTTP \(code) — \(state.message)"
                }
            case .failure(let failure, let message):
                status = "\(schemeLabel) — \(state.message) (\(failure.rawValue): \(message))"
            }
            if result.httpsAvailable {
                // Only the scheme changes here — `port` stays whatever the
                // http daemon uses. `GatewayConfig.url`/`webSocketOrigin`
                // both omit the port for https and default to 443, the
                // standard `tailscale serve` port, so there is no separate
                // "https port" to persist, and the http port survives a
                // later switch back if https ever stops working.
                if scheme != "https" {
                    scheme = "https"
                    status += " Switched Settings to HTTPS — it's available now."
                }
            } else {
                status += " HTTPS isn't available on this gateway yet; staying on HTTP."
            }
            testing = false
        }
    }
}
