import SwiftUI
import WebKit

/// The WKWebView that hosts the page, wired to `NativeBridge` and the
/// `vaultgw://` scheme handler.
///
/// The web view is opaque: `body` in ios-web/ios.css paints its own solid
/// `#0d1117` background plus gradients, so it fully occludes the native
/// SwiftUI background behind it (which WKWebView cannot backdrop-blur
/// through in any case). `backgroundColor` below only covers the launch
/// flash and the post-jetsam reload flash before that CSS has painted.
struct WebHost: UIViewRepresentable {
    let bridge: NativeBridge
    var inspectable: Bool
    /// Fires on every completed navigation, including the reload after a
    /// content-process crash: the page is new, so it has missed every dispatch
    /// so far and needs the current connectivity state pushed at it.
    var onPageLoad: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(WebSchemeHandler(), forURLScheme: WebSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.suppressesIncrementalRendering = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let controller = WKUserContentController()
        controller.addScriptMessageHandler(
            bridge, contentWorld: .page, name: NativeBridge.handlerName
        )
        // Lock zoom from the markup side as well as the gesture side, so a
        // page that ships its own viewport meta still cannot pinch-scale.
        controller.addUserScript(WKUserScript(
            source: Self.viewportLockScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        #if DEBUG
        if let seed = DebugLaunchEnvironment.settingsSeedScript() { controller.addUserScript(seed) }
        #endif
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        context.coordinator.bridge = bridge
        context.coordinator.onPageLoad = onPageLoad
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.overrideUserInterfaceStyle = .dark
        // Opaque, matching body's own #0d1117 background (ios-web/ios.css):
        // the page fully occludes the native gradient behind it, so leaving
        // the web view non-opaque only paid alpha-blending cost on every
        // composited frame for a layer nobody can see. This color is just the
        // launch flash / content-process-crash reload flash color.
        webView.backgroundColor = UIColor(red: 0.051, green: 0.067, blue: 0.09, alpha: 1)
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.minimumZoomScale = 1
        webView.allowsBackForwardNavigationGestures = false
        applyInspectable(webView)

        bridge.webView = webView
        context.coordinator.webView = webView
        webView.load(URLRequest(url: WebSchemeHandler.indexURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.bridge = bridge
        context.coordinator.onPageLoad = onPageLoad
        applyInspectable(webView)
    }

    private func applyInspectable(_ webView: WKWebView) {
        #if DEBUG
        webView.isInspectable = true
        #else
        // Release builds only expose Safari Web Inspector when the developer
        // toggle in Settings is on.
        webView.isInspectable = inspectable
        #endif
    }

    private static let viewportLockScript = """
    (function () {
      var meta = document.querySelector('meta[name=viewport]');
      if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; \
    document.head && document.head.appendChild(meta); }
      meta.setAttribute('content',
        'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    })();
    """

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        weak var bridge: NativeBridge?
        var onPageLoad: () -> Void = {}

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Before onPageLoad: it dispatches `connectivity` (and the DEBUG
            // autosend hook dispatches `share`), both of which must land on a
            // page that can actually receive them.
            bridge?.markPageReady()
            onPageLoad()
        }

        /// The content process can be jetsammed while the app sits in the
        /// background; without this the user comes back to a white void.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // The reload's page hasn't re-run its module script yet, so any
            // dispatch issued before the next didFinish must queue rather than
            // evaluate into a `window.__vaultgw` that no longer exists.
            bridge?.markPageNotReady()
            webView.load(URLRequest(url: WebSchemeHandler.indexURL))
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            if url.scheme == WebSchemeHandler.scheme || url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            // Anything else (an http link in a Claude reply) leaves the app.
            if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url, url.scheme?.hasPrefix("http") == true {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }
}
