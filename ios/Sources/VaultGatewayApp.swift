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
        #if DEBUG
        // After the Secrets seed, so an automated launch wins over it.
        DebugLaunchEnvironment.applyIfPresent()
        #endif
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
    /* The banner is a native view drawn OVER the web view. Without reserving
       its height in the safe-area inset the page gets, it lands on top of the
       page header and hides the settings / new-tab buttons for as long as the
       problem lasts. */
    @State private var bannerHeight: CGFloat = 0
    @State private var safeInsets = EdgeInsets()

    var body: some View {
        ZStack {
            background
                .ignoresSafeArea()

            WebHost(bridge: bridge, inspectable: webInspector) {
                if let state = monitor.state { bridge.dispatchConnectivity(state) }
                #if DEBUG
                DebugLaunchEnvironment.autosendIfNeeded(bridge: bridge)
                #endif
            }
            .ignoresSafeArea()

            // Respects the safe area on purpose: this is where the native
            // safeArea insets that the page gets come from.
            GeometryReader { proxy in
                Color.clear
                    .onAppear { safeInsets = proxy.safeAreaInsets }
                    .onChange(of: proxy.safeAreaInsets) { _, new in safeInsets = new }
            }
            .allowsHitTesting(false)

            VStack(spacing: 0) {
                if let state = monitor.state, state.isProblem {
                    ConnectivityBanner(state: state) { showSettings = true }
                        .background(GeometryReader { proxy in
                            Color.clear
                                .onAppear { bannerHeight = proxy.size.height }
                                .onChange(of: proxy.size.height) { _, h in bannerHeight = h }
                                .onDisappear { bannerHeight = 0 }
                        })
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
            #if DEBUG
            DebugLaunchEnvironment.startCommandChannel(bridge: bridge)
            #endif
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
        .onChange(of: safeInsets) { _, _ in pushInsets() }
        .onChange(of: bannerHeight) { _, _ in pushInsets() }
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

    private func pushInsets() {
        bridge.updateSafeArea(SafeAreaInsets(
            top: safeInsets.top + bannerHeight,
            bottom: safeInsets.bottom,
            left: safeInsets.leading,
            right: safeInsets.trailing
        ))
    }
}
