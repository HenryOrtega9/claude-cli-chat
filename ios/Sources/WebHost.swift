import SwiftUI
import WebKit

/// The WKWebView that hosts the page, wired to `NativeBridge` and the
/// `vaultgw://` scheme handler.
///
/// The web view is transparent on purpose: the native dark gradient behind it
/// is what the page's glass (`backdrop-filter`) blurs against, so the chrome
/// looks like one surface instead of a web view pasted onto a background.
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
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        context.coordinator.onPageLoad = onPageLoad
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.overrideUserInterfaceStyle = .dark
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
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
        var onPageLoad: () -> Void = {}

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onPageLoad()
        }

        /// The content process can be jetsammed while the app sits in the
        /// background; without this the user comes back to a white void.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
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
