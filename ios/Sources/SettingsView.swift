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

    var body: some View {
        NavigationStack {
            Form {
                Section("Gateway") {
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
                        .disabled(testing)
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

    private func testConnection() {
        saveToken()
        testing = true
        status = "Testing…"
        Task {
            let outcome = await GatewayClient.send(path: "/health")
            let state = ConnectivityState.from(outcome)
            switch outcome {
            case .http(let code, let data):
                if code == 200 {
                    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    let gatewayState = json?["state"] as? String ?? "ready"
                    var line = "Connected. Gateway is \(gatewayState)."
                    if let cwd = json?["cwd"] as? String, !cwd.isEmpty {
                        line += " Vault: \((cwd as NSString).lastPathComponent)."
                    }
                    status = line
                } else {
                    status = "HTTP \(code) — \(state.message)"
                }
            case .failure(let failure, let message):
                status = "\(state.message) (\(failure.rawValue): \(message))"
            }
            testing = false
        }
    }
}
