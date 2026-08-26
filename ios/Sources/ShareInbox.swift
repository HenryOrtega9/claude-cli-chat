import Foundation

/// Reads what `ios/ShareExtension/ShareViewController.swift` drops into the
/// App Group container and turns each one into a `share` dispatch — the same
/// channel `DebugLaunchEnvironment`'s `VAULTGW_AUTOSEND` hook and
/// `NativeBridge.dispatch("share", …)` already use, landing in
/// `IosChatShell.handleShare` (`ios-web/src/shell.ts`) via the `renderer.ts`
/// switch-case. `handleShare` buffers until the composer DOM actually exists
/// (mount() may not have run yet on a cold launch) rather than dropping a
/// share that arrives too early.
///
/// One JSON manifest + zero or more JPEGs per share, all prefixed with the
/// same UUID, so a share extension process writing one unit is never observed
/// half-written by a `drain()` that races it (see the write-order comment in
/// `ShareViewController.write`).
enum ShareInbox {
    private static let folderName = "ShareInbox"

    private struct Item: Decodable {
        let id: String
        let text: String?
        let images: [String]?
    }

    private static var directoryURL: URL? {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: GatewayConfig.appGroup
        ) else { return nil }
        return container.appendingPathComponent(folderName, isDirectory: true)
    }

    /// Reads every pending share, dispatches it into the page, and deletes
    /// the files. Called from `onOpenURL` (the extension's hand-off) AND on
    /// every `.active` scenePhase transition (belt-and-suspenders: the app
    /// may already be foreground when a second share lands, with no new
    /// `onOpenURL` to hang a drain off). Safe to call from both, and safe to
    /// call when there is nothing to drain: each manifest is deleted before
    /// its dispatch fires, so two overlapping calls just mean the second one
    /// finds nothing.
    ///
    /// Dispatching into a page that has not finished loading yet is fine —
    /// `NativeBridge.dispatch` queues until `markPageReady()` fires and
    /// replays in order, the same mechanism a `connectivity` or `safeArea`
    /// dispatch arriving before boot relies on.
    ///
    /// The file reads and base64 encoding (up to 4 images, downscaled to
    /// 2048px JPEG q0.82 — several MB before encoding, ~1.33x that after) run
    /// off the main actor: `drain` fires on `.active`/`didFinish`, exactly the
    /// launch/foreground moment where a synchronous multi-megabyte read +
    /// encode would show up as a hitch.
    @MainActor
    static func drain(bridge: NativeBridge) {
        guard let dir = directoryURL else { return }
        Task.detached(priority: .userInitiated) {
            let fm = FileManager.default
            guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
            var payloads: [[String: Any]] = []
            for name in names.filter({ $0.hasSuffix(".json") }).sorted() {
                let manifestURL = dir.appendingPathComponent(name)
                guard let data = try? Data(contentsOf: manifestURL) else { continue }
                try? fm.removeItem(at: manifestURL)
                guard let item = try? JSONDecoder().decode(Item.self, from: data) else { continue }
                if let payload = buildPayload(item, dir: dir, fm: fm) {
                    payloads.append(payload)
                }
            }
            sweepOrphans(dir: dir, fm: fm, names: names)
            guard !payloads.isEmpty else { return }
            await MainActor.run {
                for payload in payloads { bridge.dispatch("share", payload) }
            }
        }
    }

    /// A `ShareViewController` process killed (OOM under the ~120MB extension
    /// budget, force-quit mid-share) between writing an image and writing the
    /// manifest that references it (see the write-order comment in
    /// `ShareViewController.write`) leaves that image behind forever: the loop
    /// above only ever looks at `*.json` names, so an unreferenced
    /// `<uuid>-N.jpg` has nothing that will ever delete it — a slow disk leak
    /// across repeated interrupted shares.
    ///
    /// `names` is the directory listing from BEFORE this drain's own
    /// processing, so files this run's manifests just legitimately consumed
    /// (and already deleted, in `buildPayload`'s `defer`) are simply not
    /// found on re-lookup and skipped — `attributesOfItem` on a path that no
    /// longer exists returns nil, which the guard below treats as "leave it
    /// alone", not an error.
    ///
    /// The 60s age cutoff is what keeps this from racing a legitimate
    /// in-flight write: a second Share Extension process that has written its
    /// image(s) but not yet its manifest (see `ShareViewController.write` —
    /// images land first, manifest last, atomically) looks identical to an
    /// orphan for the handful of milliseconds that write takes, but nothing
    /// short of a genuine crash leaves a file sitting unreferenced for a full
    /// minute.
    private static func sweepOrphans(dir: URL, fm: FileManager, names: [String]) {
        let cutoff = Date().addingTimeInterval(-60)
        for name in names where !name.hasSuffix(".json") {
            let url = dir.appendingPathComponent(name)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path),
                  let modified = attrs[.modificationDate] as? Date,
                  modified < cutoff
            else { continue }
            try? fm.removeItem(at: url)
        }
    }

    /// Builds one `share` dispatch payload from a manifest item — the file
    /// reads and base64 encoding, run off the main actor by `drain`. Returns
    /// nil when there is nothing to send (no text and no readable image).
    private static func buildPayload(_ item: Item, dir: URL, fm: FileManager) -> [String: Any]? {
        var payload: [String: Any] = [:]
        if let text = item.text, !text.isEmpty { payload["text"] = text }

        // Sent as `images: [{mediaType, dataUri}]`; the page side
        // (ios-web/src/renderer.ts's `case "share"` -> parseSharePayload ->
        // IosChatShell.handleShare -> InputBox.addImageAttachments) turns
        // each into a composer attachment chip identical to one added via
        // the + button or a paste. See "Share Extension" in ios/README.md.
        var images: [[String: String]] = []
        for filename in item.images ?? [] {
            let fileURL = dir.appendingPathComponent(filename)
            defer { try? fm.removeItem(at: fileURL) }
            guard let data = try? Data(contentsOf: fileURL) else { continue }
            let mediaType = "image/jpeg" // ShareViewController always writes downscaled JPEGs.
            images.append(["mediaType": mediaType, "dataUri": "data:\(mediaType);base64,\(data.base64EncodedString())"])
        }
        if !images.isEmpty { payload["images"] = images }

        guard payload["text"] != nil || payload["images"] != nil else { return nil }
        return payload
    }
}
