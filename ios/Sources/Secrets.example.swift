// Template for the gitignored Sources/Secrets.swift.
//
//   cp Sources/Secrets.example.swift Sources/Secrets.swift
//
// These are only first-launch seeds: host/port land in the App Group defaults
// and the token lands in the Keychain the first time the app runs, and every
// one of them is editable afterwards in Settings. Leave a field empty (or 0)
// to fall back to the built-in default in GatewayConfig.
//
// Adapted from ask-claude-watch/Sources/Secrets.swift.
enum Secrets {
    static let gatewayHost = ""
    static let gatewayPort = 0
    static let gatewayToken = ""
}
