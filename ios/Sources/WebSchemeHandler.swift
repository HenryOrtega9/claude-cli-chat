import Foundation
import WebKit

/// Serves `vaultgw://app/...` out of the bundled `Web/` folder reference.
///
/// A custom scheme (rather than `file://`) gives the page a real, stable
/// origin, so localStorage, IndexedDB, service-worker-free fetch and
/// WebSocket upgrades all behave like a normal web app.
final class WebSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "vaultgw"
    static let indexURL = URL(string: "\(WebSchemeHandler.scheme)://app/index.html")!

    private let root: URL?
    private let queue = DispatchQueue(label: "dev.henryortega.vaultgateway.web", qos: .userInitiated)
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    override init() {
        root = Bundle.main.url(forResource: "Web", withExtension: nil)
        super.init()
    }

    private static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "htm": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "map": "application/json; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "ico": "image/x-icon",
        "woff2": "font/woff2",
        "woff": "font/woff",
        "ttf": "font/ttf",
        "wasm": "application/wasm",
        "txt": "text/plain; charset=utf-8",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        let url = urlSchemeTask.request.url
        queue.async { [weak self] in
            guard let self else { return }
            let resolved = self.resolve(url)
            // `stop` may have landed while `resolve` was running; either way,
            // the ObjectIdentifier it inserted must not linger in `stopped`
            // forever, or a reload that cancels a batch of in-flight tasks
            // (webViewWebContentProcessDidTerminate) leaks one entry per task
            // for the life of the WKWebView.
            guard !self.isStopped(key) else {
                self.clearStopped(key)
                return
            }
            guard let resolved, let data = try? Data(contentsOf: resolved.file) else {
                self.finish(urlSchemeTask, key: key, status: 404,
                            data: Data("Not found".utf8), mime: "text/plain; charset=utf-8",
                            url: url ?? Self.indexURL)
                return
            }
            self.finish(urlSchemeTask, key: key, status: 200, data: data,
                        mime: resolved.mime, url: url ?? Self.indexURL)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        lock.lock()
        stopped.insert(ObjectIdentifier(urlSchemeTask))
        lock.unlock()
    }

    private func isStopped(_ key: ObjectIdentifier) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped.contains(key)
    }

    private func clearStopped(_ key: ObjectIdentifier) {
        lock.lock()
        stopped.remove(key)
        lock.unlock()
    }

    private func finish(
        _ task: any WKURLSchemeTask, key: ObjectIdentifier,
        status: Int, data: Data, mime: String, url: URL
    ) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            // The bundle is the cache; never let WebKit serve a stale asset
            // across an app update.
            "Cache-Control": "no-cache",
        ]
        guard let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
        ) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard !self.isStopped(key) else {
                self.clearStopped(key)
                return
            }
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
            self.lock.lock()
            self.stopped.remove(key)
            self.lock.unlock()
        }
    }

    /// Maps a request URL onto a file inside the bundled Web folder, refusing
    /// anything that escapes it.
    private func resolve(_ url: URL?) -> (file: URL, mime: String)? {
        guard let url, let root else { return nil }
        var relative = url.path
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }
        let candidate = root.appendingPathComponent(relative).standardizedFileURL
        let rootPath = root.standardizedFileURL.path
        guard candidate.path == rootPath || candidate.path.hasPrefix(rootPath + "/") else { return nil }

        var file = candidate
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory)
        if exists, isDirectory.boolValue {
            file = file.appendingPathComponent("index.html")
        } else if !exists {
            // Client-side routes ("/tabs/abc") fall back to the shell, the way
            // a static host with a SPA rewrite would. Missing assets (anything
            // with an extension) still 404.
            guard file.pathExtension.isEmpty else { return nil }
            file = root.appendingPathComponent("index.html")
        }
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let ext = file.pathExtension.lowercased()
        return (file, Self.mimeTypes[ext] ?? "application/octet-stream")
    }
}
