import SwiftUI
import UserNotifications

/// Receives the relaunch when the TurnNotifier's background /wait download
/// finishes while the app is suspended or not running. SwiftUI's App lifecycle
/// has no hook for that, hence the adaptor.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        GatewayConfig.seedFromSecretsIfNeeded()
        UNUserNotificationCenter.current().delegate = TurnNotifier.shared
        TurnNotifier.shared.registerCategories()
        return true
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == TurnNotifier.sessionID else {
            completionHandler()
            return
        }
        TurnNotifier.shared.handleBackgroundEvents(completion: completionHandler)
    }
}

@main
struct VaultGatewayApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @StateObject private var bridge = NativeBridge()
    @StateObject private var monitor = ConnectivityMonitor()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(GatewayConfig.Key.webInspector, store: GatewayConfig.suite)
    private var webInspector = false
    @State private var showSettings = false
    @State private var didFirstLaunchCheck = false

    var body: some View {
        ZStack {
            background
                .ignoresSafeArea()

            WebHost(bridge: bridge, inspectable: webInspector) {
                if let state = monitor.state { bridge.dispatchConnectivity(state) }
            }
            .ignoresSafeArea()

            // Respects the safe area on purpose: this is where the native
            // safeArea insets that the page gets come from.
            GeometryReader { proxy in
                Color.clear
                    .onAppear { push(insets: proxy.safeAreaInsets) }
                    .onChange(of: proxy.safeAreaInsets) { _, new in push(insets: new) }
            }
            .allowsHitTesting(false)

            VStack(spacing: 0) {
                if let state = monitor.state, state.isProblem {
                    ConnectivityBanner(state: state) { showSettings = true }
                }
                Spacer(minLength: 0)
            }
            .animation(.easeInOut(duration: 0.2), value: monitor.state)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView {
                monitor.probe()
            }
        }
        .onAppear {
            bridge.onOpenSettings = { showSettings = true }
            // Not only on .active: a permission alert at first launch keeps the
            // scene .inactive indefinitely, and the banner still has to work.
            monitor.start()
            if !didFirstLaunchCheck {
                didFirstLaunchCheck = true
                // Nothing works without a token, so go straight there.
                if !GatewayConfig.hasToken { showSettings = true }
            }
        }
        .onChange(of: monitor.state) { _, state in
            guard let state else { return }
            bridge.dispatchConnectivity(state)
            // Ask about notifications once the app is actually usable rather
            // than throwing an alert at a first launch that cannot connect.
            if state == .ok { TurnNotifier.shared.requestAuthorizationIfNeeded() }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                TurnNotifier.shared.cancelAll()
                TurnNotifier.shared.clearDeliveredNotifications()
                monitor.start()
                bridge.dispatch("resume")
                if let state = monitor.state { bridge.dispatchConnectivity(state) }
            case .inactive, .background:
                // The page closes its socket and flushes setState; the
                // persisted busyTabs from that call is what arms the wait.
                bridge.dispatch("suspend")
                monitor.stop()
                TurnNotifier.shared.armFromPersistedState()
            @unknown default:
                break
            }
        }
    }

    /// GitHub-dark base with a faint Claude-orange glow near the top, so the
    /// page's translucent header has something warm to blur.
    private var background: some View {
        ZStack {
            LinearGradient(
                colors: [Color(hex: 0x0d1117), Color(hex: 0x161b22)],
                startPoint: .top,
                endPoint: .bottom
            )
            RadialGradient(
                colors: [Color(hex: 0xd97757, opacity: 0.06), Color(hex: 0xd97757, opacity: 0)],
                center: UnitPoint(x: 0.5, y: 0.04),
                startRadius: 0,
                endRadius: 440
            )
        }
    }

    private func push(insets: EdgeInsets) {
        bridge.updateSafeArea(SafeAreaInsets(
            top: insets.top,
            bottom: insets.bottom,
            left: insets.leading,
            right: insets.trailing
        ))
    }
}
