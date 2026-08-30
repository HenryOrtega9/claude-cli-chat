import Foundation
import SwiftUI

/// Probes `GET /health` (3 s budget) and classifies the outcome into the
/// CONTRACTS.md connectivity states. Runs on foreground and every 20 s while
/// the app stays foregrounded; nothing polls in the background, where the
/// TurnNotifier's long-poll is the only network activity.
@MainActor
final class ConnectivityMonitor: ObservableObject {
    /// nil until the first probe lands, so nothing downstream ever reports a
    /// state the app has not actually measured.
    @Published private(set) var state: ConnectivityState?

    private var timer: Timer?
    private var probeTask: Task<Void, Never>?
    private static let interval: TimeInterval = 20

    func start() {
        stopTimer()
        probe()
        let timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.probe() }
        }
        timer.tolerance = 5
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        stopTimer()
        probeTask?.cancel()
        probeTask = nil
    }

    func probe() {
        guard probeTask == nil else { return }
        probeTask = Task { [weak self] in
            let outcome: GatewayClient.Outcome
            if GatewayConfig.hasToken {
                outcome = await GatewayClient.probe()
            } else {
                // No token yet: the gateway would 401 anyway, and saying so is
                // the actionable message.
                outcome = .http(status: 401, data: Data())
            }
            guard let self, !Task.isCancelled else { return }
            // `@Published` fires on every assignment regardless of whether
            // the value differs, so an unconditional write here republishes
            // (and invalidates RootView's whole body) every 20s even in the
            // steady .ok case. Guard it since ConnectivityState is Equatable.
            let next = ConnectivityState.from(outcome)
            if next != self.state { self.state = next }
            self.probeTask = nil
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }
}
