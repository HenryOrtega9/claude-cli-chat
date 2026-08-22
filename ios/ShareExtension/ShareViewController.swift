import ImageIO
import UIKit
import UniformTypeIdentifiers

/// The Share Extension's entire UI: no compose box, no picker — just "Sent to
/// Claude" for a beat while the shared items land in the App Group inbox,
/// then a hand-off to the main app via the `vaultgw-share://` scheme.
///
/// `NSExtensionPrincipalClass` in `ios/ShareExtension/Info.plist` (declared in
/// `project.yml`) names this class as `$(PRODUCT_MODULE_NAME).ShareViewController`;
/// a plain `NSObject`-rooted Swift class (UIViewController is one) exposes
/// exactly that as its Objective-C runtime name, so no `@objc(...)` override
/// is needed. `ShareInbox.swift` (main-app target, not this one — extensions
/// and the host app do not share a source list) is the reader for what gets
/// written here.
final class ShareViewController: UIViewController {
    /// Must match `GatewayConfig.appGroup` in the main-app target. Duplicated
    /// as a literal rather than sharing `GatewayConfig.swift` into this
    /// target, which would drag in Keychain/SwiftUI/@AppStorage dependencies
    /// this tiny extension has no use for.
    private static let appGroupID = "group.dev.henryortega.vaultgateway"
    private static let openURL = URL(string: "vaultgw-share://open")!
    private static let maxDimension: CGFloat = 2048
    private static let jpegQuality: CGFloat = 0.82

    private let statusLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        configureUI()
        processInputItems()
    }

    private func configureUI() {
        view.backgroundColor = UIColor(white: 0.06, alpha: 1)
        // Deliberately not "Sent to Claude": extensionContext.open(_:) below
        // is attempted, but Apple documents it as working ONLY from a Today
        // widget — Share Extensions are explicitly excluded — and developer
        // reports confirm it silently no-ops (completion handler returns
        // false) from real Share Extensions in practice. Promising delivery
        // here would be a lie the UI can't back up. What's actually
        // guaranteed is the App Group write above, which already succeeded
        // by the time this shows: ShareInbox.drain() picks it up the moment
        // the user reopens the app, via `.active` if `open(_:)` doesn't
        // manage to launch it. See "Share Extension" in ios/README.md.
        statusLabel.text = "Saved. Open Claude & Second Brain to send it."
        statusLabel.numberOfLines = 0
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.alpha = 0
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
        ])
    }

    private func showConfirmation(failed: Bool = false) {
        if failed { statusLabel.text = "Couldn't share that" }
        UIView.animate(withDuration: 0.15) { self.statusLabel.alpha = 1 }
    }

    // MARK: - Extraction

    private func processInputItems() {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty else {
            finish(wroteAnything: false)
            return
        }

        let group = DispatchGroup()
        var text: String?
        var imageDatas: [Data] = []
        let lock = NSLock()

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: UTType.url.identifier) { coding, _ in
                    if let url = coding as? URL {
                        lock.lock(); if text == nil { text = url.absoluteString }; lock.unlock()
                    }
                    group.leave()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { coding, _ in
                    if let s = coding as? String {
                        lock.lock(); if text == nil { text = s }; lock.unlock()
                    }
                    group.leave()
                }
            }

            // Not an `else if`: Photos can hand a share item that is BOTH a
            // file URL string (matched above, discarded — a `file://` string
            // is useless as composer text) and an image attachment, so image
            // extraction has to run independently of the text branch.
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                group.enter()
                Self.loadDownscaledImage(provider) { data in
                    if let data { lock.lock(); imageDatas.append(data); lock.unlock() }
                    group.leave()
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            // A `file://` URL leaking in from the image branch's text load
            // (some apps hand back the local file path as the "url" item
            // rather than a web link) is not useful composer text.
            let cleaned = text.flatMap { $0.hasPrefix("file://") ? nil : $0 }
            self?.write(text: cleaned, images: imageDatas)
        }
    }

    /// Prefers `loadFileRepresentation`, which copies the item to a temp file
    /// without decoding it into memory first — a Share Extension's process
    /// budget (roughly 120MB) does not survive `UIImage(data:)` on a 48MP
    /// photo followed by a redraw. ImageIO's thumbnail generator then decodes
    /// directly at the target size instead of materializing the full-
    /// resolution bitmap at all.
    private static func loadDownscaledImage(_ provider: NSItemProvider, completion: @escaping (Data?) -> Void) {
        provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
            guard let url else {
                // Some sources (screenshots held in the pasteboard, certain
                // third-party apps) only hand back an in-memory object, not a
                // file on disk.
                provider.loadItem(forTypeIdentifier: UTType.image.identifier) { coding, _ in
                    completion(downscaledJPEG(fromObject: coding))
                }
                return
            }
            // loadFileRepresentation deletes its temp file the instant this
            // closure returns, so decode synchronously before returning.
            completion(downscaledJPEG(fromURL: url))
        }
    }

    private static func downscaledJPEG(fromURL url: URL) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return downscaledJPEG(source: source)
    }

    private static func downscaledJPEG(fromObject object: NSSecureCoding?) -> Data? {
        if let url = object as? URL, let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
            return downscaledJPEG(source: source)
        }
        if let data = object as? Data, let source = CGImageSourceCreateWithData(data as CFData, nil) {
            return downscaledJPEG(source: source)
        }
        if let image = object as? UIImage {
            return image.jpegData(compressionQuality: jpegQuality)
        }
        return nil
    }

    private static func downscaledJPEG(source: CGImageSource) -> Data? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: jpegQuality)
    }

    // MARK: - Write + handoff

    private func write(text: String?, images: [Data]) {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupID
        ) else {
            finish(wroteAnything: false)
            return
        }
        let dir = container.appendingPathComponent("ShareInbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // One UUID-prefixed unit per share: the main app may be mid-drain of
        // an earlier share (or a second share extension process may be
        // running concurrently) and must never see a half-written manifest
        // referencing images that are not on disk yet.
        let id = UUID().uuidString
        var imageNames: [String] = []
        for (index, data) in images.enumerated() {
            let name = "\(id)-\(index).jpg"
            if (try? data.write(to: dir.appendingPathComponent(name), options: .atomic)) != nil {
                imageNames.append(name)
            }
        }

        guard text != nil || !imageNames.isEmpty else {
            finish(wroteAnything: false)
            return
        }

        var manifest: [String: Any] = ["id": id, "images": imageNames]
        if let text { manifest["text"] = text }
        guard JSONSerialization.isValidJSONObject(manifest),
              let json = try? JSONSerialization.data(withJSONObject: manifest)
        else {
            finish(wroteAnything: false)
            return
        }
        // Manifest written LAST, atomically: the main app's ShareInbox.drain
        // only looks for `*.json` files, so nothing reads the image files
        // above until this one lands, and `.atomic` means it never observes
        // a partially-written manifest either.
        guard (try? json.write(to: dir.appendingPathComponent("\(id).json"), options: .atomic)) != nil else {
            finish(wroteAnything: false)
            return
        }

        showConfirmation()
        // Give "Sent to Claude" a beat on screen before the app switch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.finish(wroteAnything: true)
        }
    }

    private func finish(wroteAnything: Bool) {
        guard wroteAnything else {
            showConfirmation(failed: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
            return
        }
        // Best-effort only — verified against Apple's own documentation and
        // developer-forum reports (2026-08-21): `NSExtensionContext.open(_:completionHandler:)`
        // is documented as usable ONLY from a Today (Notification Center)
        // widget; Share Extensions are explicitly excluded, and the
        // documented alternative, `completeRequest`, does not open the
        // host app either — there is no Apple-sanctioned way for a Share
        // Extension to launch its containing app. The classic "walk the
        // responder chain to something that responds to `openURL:`" trick
        // does not help here either: it depends on a live `UIApplication`
        // instance somewhere up the chain, and a Share Extension is its own
        // process with no `UIApplication` — it only works for extension
        // types that share a process with a host, which this is not. So
        // this call is left in (cheap, harmless, and occasionally reported
        // to work) but nothing downstream depends on its completion
        // succeeding: the App Group write above already durably saved the
        // share, and `ShareInbox.drain()` runs on every `.active`
        // transition, so the guaranteed path is the user reopening the app
        // themselves — see the `statusLabel` text above and "Share
        // Extension" in ios/README.md.
        extensionContext?.open(Self.openURL) { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }
}
