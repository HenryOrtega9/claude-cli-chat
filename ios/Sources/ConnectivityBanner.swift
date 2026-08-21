import SwiftUI
import UIKit

/// Native connectivity banner. The page may render its own inline hint, but per
/// CONTRACTS.md the native banner is the indicator that must always be there —
/// including when the page itself failed to load.
struct ConnectivityBanner: View {
    let state: ConnectivityState
    let onOpenSettings: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(hex: 0xd97757))
            Text(state.message)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white.opacity(0.92))
                .lineLimit(2)
            Spacer(minLength: 8)
            if let title = state.actionTitle {
                Button(title, action: performAction)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(hex: 0xd97757))
                    .frame(minHeight: 44)
                    .fixedSize()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(.white.opacity(0.12), lineWidth: 1)
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var icon: String {
        switch state {
        case .ok: return "checkmark.circle"
        case .tailscaleOff: return "network.slash"
        case .macAsleep: return "moon.zzz"
        case .gatewayDown: return "bolt.horizontal.circle"
        case .unauthorized: return "key.slash"
        case .starting: return "hourglass"
        }
    }

    private func performAction() {
        switch state.action {
        case .openSettings:
            onOpenSettings()
        case .openTailscale:
            openTailscale()
        case .none:
            break
        }
    }

    /// No public deep link is documented for the Tailscale iOS app, so try its
    /// URL scheme and fall back to this app's Settings page, which is one tap
    /// from the VPN switch.
    private func openTailscale() {
        guard let url = URL(string: "tailscale://") else { return }
        UIApplication.shared.open(url, options: [:]) { opened in
            guard !opened, let settings = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(settings)
        }
    }
}

extension Color {
    /// 0xRRGGBB literal, so the palette can be pasted straight from the CSS.
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: opacity
        )
    }
}
