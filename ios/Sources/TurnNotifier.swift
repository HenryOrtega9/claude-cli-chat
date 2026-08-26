import Foundation
import OSLog
import UIKit
import UserNotifications

/// Background long-poll against the gateway's `GET /wait`.
///
/// Ported from ask-claude-watch/Sources/TurnNotifier.swift; the mechanism is
/// identical (a background URLSession download that the system finishes while
/// the app is suspended, then relaunches us to deliver), with three changes for
/// iOS: the wait is per tab, the delivered frame may be an `approval_request`
/// as well as a `turn_done`, and an approval notification carries Allow/Deny
/// actions that POST straight back to the gateway.
final class TurnNotifier: NSObject {
    static let shared = TurnNotifier()
    static let sessionID = "dev.henryortega.vaultgateway.wait"
    static let approvalCategory = "VG_APPROVAL"
    private static let allowAction = "VG_APPROVE_ALLOW"
    private static let denyAction = "VG_APPROVE_DENY"
    /// Matches the gateway's default approval deadline; one wait spans a whole
    /// turn, so there is no re-arm logic.
    private static let waitSeconds = 600

    private var session: URLSession?
    private var backgroundCompletion: (() -> Void)?

    /// Wired from `RootView.onAppear` once the `NativeBridge` `@StateObject`
    /// exists. `TurnNotifier.shared` is a process-lifetime singleton that can
    /// receive `didReceive response` (a notification tap that launches the
    /// app from cold) before SwiftUI has built the view hierarchy at all, so
    /// a tap arriving before this is wired must not be lost — see
    /// `pendingSwitch` / `flushPendingSwitch()` below.
    weak var bridge: NativeBridge? {
        didSet { flushPendingSwitch() }
    }

    /// A `switchTab` deep link that arrived before `bridge` was wired.
    /// Flushed the moment `bridge` is set. At most one entry: a second tap
    /// before the first flushes simply replaces it, which is the same
    /// "latest wins" semantics `dispatch`'s own queue has for everything
    /// else that only makes sense once (there is only one page to land on).
    private var pendingSwitch: (tab: String, requestId: String)?

    /// `log stream --predicate 'subsystem == "dev.henryortega.vaultgateway"'`
    /// is the only way to watch this path: everything interesting happens while
    /// the app is suspended, where there is no UI to look at.
    static let log = Logger(subsystem: "dev.henryortega.vaultgateway", category: "turns")

    // MARK: - Setup

    func registerCategories() {
        let allow = UNNotificationAction(identifier: Self.allowAction, title: "Allow", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive])
        let category = UNNotificationCategory(
            identifier: Self.approvalCategory,
            actions: [allow, deny],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    private var didRequestAuthorization = false

    /// Called the first time the app reaches a connected state; the system
    /// only ever shows the prompt once anyway.
    func requestAuthorizationIfNeeded() {
        guard !didRequestAuthorization else { return }
        didRequestAuthorization = true
        var options: UNAuthorizationOptions = [.alert, .sound, .badge]
        #if DEBUG
        // An automated launch has nobody to tap "Allow", and the simulator on
        // this machine has no window to tap in. .provisional is granted
        // without a prompt (quiet delivery, no banner), which is enough to
        // prove the background /wait -> notification path end to end.
        if DebugLaunchEnvironment.isActive { options.insert(.provisional) }
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: options) { granted, error in
            Self.log.info("authorization granted=\(granted, privacy: .public) error=\(error?.localizedDescription ?? "none", privacy: .public)")
        }
    }

    // MARK: - Arming

    /// Set while a `.background` scenePhase transition is waiting on the
    /// page's post-suspend `setState` flush to reach `NativeBridge.persistState`
    /// before arming — reading `UserDefaults` synchronously at the moment of
    /// backgrounding always sees the pre-suspend snapshot, since that flush is
    /// still two async `postMessage` hops away. `armIfPending()` is the fast
    /// path (fired by `persistState` the instant the flush lands); the
    /// fallback timer is the safety net for a page that never flushes at all
    /// (already gone, frozen) so backgrounding still ends up arming from
    /// whatever is currently persisted instead of arming nothing.
    private var armPending = false
    private var armPendingFallback: DispatchWorkItem?

    /// Called on the `.background` scenePhase transition, right after the
    /// page's `suspend` dispatch is sent. Defers the actual arm to whichever
    /// comes first: `armIfPending()` once the flush lands, or the fallback
    /// timer below.
    func armWhenBackgrounded() {
        armPendingFallback?.cancel()
        armPending = true
        let fallback = DispatchWorkItem { [weak self] in self?.armIfPending() }
        armPendingFallback = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: fallback)
    }

    /// Fires the deferred arm from `armWhenBackgrounded()`, if one is still
    /// pending. Called both by the fallback timer and by
    /// `NativeBridge.persistState` the moment the post-suspend flush actually
    /// lands, so whichever happens first wins and the other is a no-op.
    func armIfPending() {
        guard armPending else { return }
        armPending = false
        armPendingFallback?.cancel()
        armPendingFallback = nil
        armFromPersistedState()
    }

    /// Arm a wait for the most recently busy tab recorded by `setState`.
    /// No-op when nothing is busy or no token is enrolled.
    @discardableResult
    func armFromPersistedState() -> Bool {
        let suite = GatewayConfig.suite
        let busy = suite.stringArray(forKey: GatewayConfig.Key.busyTabs) ?? []
        guard !busy.isEmpty, GatewayConfig.hasToken else {
            Self.log.info("arm skipped: busy=\(busy.count, privacy: .public) hasToken=\(GatewayConfig.hasToken, privacy: .public)")
            return false
        }
        let active = suite.string(forKey: GatewayConfig.Key.activeTabId) ?? ""
        let tab = busy.contains(active) ? active : (busy.last ?? "")
        guard !tab.isEmpty else { return false }
        let seq = (suite.dictionary(forKey: GatewayConfig.Key.lastSeq)?[tab] as? Int) ?? 0
        arm(tab: tab, since: seq)
        return true
    }

    func arm(tab: String, since seq: Int) {
        let encodedTab = tab.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? tab
        let path = "/wait?tab=\(encodedTab)&since=\(seq)&timeout=\(Self.waitSeconds)"
        guard var request = GatewayClient.request(path: path) else { return }
        request.timeoutInterval = TimeInterval(Self.waitSeconds + 60)
        let session = backgroundSession()
        // Resume synchronously: the system can suspend us before getAllTasks's
        // completion runs, which would drop the wait entirely.
        let task = session.downloadTask(with: request)
        task.taskDescription = tab
        task.resume()
        Self.log.info("armed /wait tab=\(tab, privacy: .public) since=\(seq, privacy: .public)")
        session.getAllTasks { tasks in
            tasks.filter { $0.taskIdentifier != task.taskIdentifier }.forEach { $0.cancel() }
        }
    }

    func cancelAll() {
        backgroundSession().getAllTasks { tasks in
            tasks.forEach { $0.cancel() }
        }
    }

    func clearDeliveredNotifications() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    /// Called by the app delegate when the system relaunches us with pending
    /// background session events.
    func handleBackgroundEvents(completion: @escaping () -> Void) {
        backgroundCompletion = completion
        _ = backgroundSession()
    }

    private func backgroundSession() -> URLSession {
        if let session { return session }
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionID)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        // /wait sends no bytes until the turn finishes, so the default 60 s
        // idle timeout would kill any turn longer than a minute.
        config.timeoutIntervalForRequest = TimeInterval(Self.waitSeconds + 60)
        config.timeoutIntervalForResource = TimeInterval(Self.waitSeconds + 120)
        let created = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        session = created
        return created
    }

    // MARK: - Frame → notification

    private func notify(frame: [String: Any], tabHint: String?) {
        let tab = frame["tab"] as? String ?? tabHint ?? ""
        let payload = frame["payload"] as? [String: Any] ?? [:]
        let content = UNMutableNotificationContent()
        content.sound = .default
        content.userInfo = ["tab": tab]

        switch frame["t"] as? String {
        case "turn_done":
            content.title = "Claude finished"
            content.body = tabTitle(for: tab)
        case "approval_request":
            let tool = payload["tool_name"] as? String
                ?? (payload["request"] as? [String: Any])?["tool_name"] as? String
                ?? "a tool"
            content.title = "Claude needs approval: \(tool)"
            content.body = tabTitle(for: tab)
            content.categoryIdentifier = Self.approvalCategory
            if let requestID = payload["request_id"] as? String
                ?? frame["request_id"] as? String {
                content.userInfo["request_id"] = requestID
            }
        default:
            // wait_timeout / partial: nothing finished, so say nothing.
            Self.log.info("no notification for frame t=\(frame["t"] as? String ?? "?", privacy: .public)")
            return
        }
        let title = content.title
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        ) { error in
            if let error {
                Self.log.error("notification add failed: \(error.localizedDescription, privacy: .public)")
            } else {
                Self.log.info("notification posted: \(title, privacy: .public)")
            }
        }
    }

    private func tabTitle(for tab: String) -> String {
        let titles = GatewayConfig.suite.dictionary(forKey: GatewayConfig.Key.tabTitles) as? [String: String]
        if let title = titles?[tab], !title.isEmpty { return title }
        return tab.isEmpty ? "Your vault chat" : "Tab \(tab.prefix(8))"
    }

    /// Deep-link the page to the tab (and, if the tap was on an approval
    /// notification, the specific request) a notification named. Dispatched
    /// as `switchTab` — see `ios-web/src/native.ts`'s `__vaultgwSwitchTab`
    /// for why this rides its own entry point rather than
    /// `window.__vaultgw.dispatch`.
    @MainActor
    private func dispatchSwitchTab(tab: String, requestId: String, via bridge: NativeBridge) {
        var payload: [String: Any] = ["tabId": tab]
        if !requestId.isEmpty { payload["requestId"] = requestId }
        bridge.dispatch("switchTab", payload)
    }

    /// `didSet` on `bridge` is a synchronous, non-isolated context, but
    /// `NativeBridge.dispatch` is `@MainActor` — hop over explicitly rather
    /// than awaiting here (a property observer cannot be `async`).
    private func flushPendingSwitch() {
        guard let bridge, let pending = pendingSwitch else { return }
        pendingSwitch = nil
        Task { @MainActor in
            self.dispatchSwitchTab(tab: pending.tab, requestId: pending.requestId, via: bridge)
        }
    }

    private func resolve(tab: String, requestID: String, allowed: Bool) async {
        guard !tab.isEmpty, !requestID.isEmpty else { return }
        let outcome = await GatewayClient.send(
            path: "/tabs/\(tab)/approve",
            method: "POST",
            body: [
                "request_id": requestID,
                "allowed": allowed,
                "reason": allowed ? "Allowed from a notification" : "Denied from a notification",
            ]
        )
        switch outcome {
        case .http(let status, _) where (200...299).contains(status):
            Self.log.info("approval \(allowed ? "allow" : "deny", privacy: .public) sent tab=\(tab, privacy: .public)")
        case .http(let status, _):
            Self.log.error("approval send failed: http \(status, privacy: .public) tab=\(tab, privacy: .public)")
            notifyApprovalFailed(tab: tab, requestID: requestID)
        case .failure(let failure, let message):
            Self.log.error("approval send failed: \(failure.rawValue, privacy: .public) \(message, privacy: .public) tab=\(tab, privacy: .public)")
            notifyApprovalFailed(tab: tab, requestID: requestID)
        }
    }

    /// Posted when a lock-screen Allow/Deny tap's POST back to the gateway
    /// fails (offline, Mac asleep, token rotated, tab gone). The system
    /// already dismissed the action notification by then, so without this
    /// the user believes they resolved the approval when the turn is
    /// actually still blocked waiting on the Mac.
    private func notifyApprovalFailed(tab: String, requestID: String) {
        let content = UNMutableNotificationContent()
        content.title = "Couldn't send your approval"
        content.body = "Open the app to approve or deny."
        content.sound = .default
        content.categoryIdentifier = Self.approvalCategory
        content.userInfo = ["tab": tab, "request_id": requestID]
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        ) { error in
            if let error {
                Self.log.error("approval-failed notification add failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}

extension TurnNotifier: URLSessionDownloadDelegate {
    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let data = try? Data(contentsOf: location),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            Self.log.error("wait finished with an unreadable body")
            return
        }
        /* `GET /wait` answers `{frame, lastSeq}` on 200 and
           `{partial:true, error:"wait_timeout", lastSeq}` on 202. The frame
           is nested, unlike the watch bridge this was ported from. Reading `t`
           off the envelope found nothing and silently posted no notification,
           which is exactly what a background turn looks like when it fails.
           Accept a bare frame too, so a future flattening cannot regress it. */
        let frame = (body["frame"] as? [String: Any]) ?? body
        let tab = downloadTask.taskDescription ?? ""
        Self.log.info("wait delivered t=\(frame["t"] as? String ?? "?", privacy: .public) tab=\(tab, privacy: .public)")
        switch frame["t"] as? String {
        case "turn_done", "approval_request":
            notify(frame: frame, tabHint: tab)
        default:
            /* The server clamps `timeout` to WAIT_MAX_S (300 s; see
               scripts/gateway/src/server.ts) regardless of the 600 s this
               client asks for, and there is no re-arm anywhere else — a turn
               that legitimately runs longer than 5 minutes used to go
               completely silent the moment the first poll timed out, because
               `wait_timeout` fell into this same "nothing finished, say
               nothing" branch with no follow-up. Re-arm from the lastSeq the
               gateway just reported so the wait keeps spanning the turn
               across as many 300 s polls as it takes.

               Only do this for the documented `partial: true` timeout shape.
               A malformed/error body (401 after the token was revoked while
               backgrounded, 404 if the tab was deleted, an unreadable frame)
               must not re-arm, or a bad token turns into a tight poll loop
               against the gateway for as long as the OS keeps scheduling the
               background session. */
            guard body["partial"] as? Bool == true, !tab.isEmpty else {
                Self.log.info("no notification, no re-arm for frame t=\(frame["t"] as? String ?? "?", privacy: .public) tab=\(tab, privacy: .public)")
                return
            }
            let lastSeq = (body["lastSeq"] as? Int) ?? 0
            Self.log.info("wait re-arming after timeout tab=\(tab, privacy: .public) since=\(lastSeq, privacy: .public)")
            arm(tab: tab, since: lastSeq)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }
}

extension TurnNotifier: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let tab = info["tab"] as? String ?? ""
        let requestID = info["request_id"] as? String ?? ""
        switch response.actionIdentifier {
        case Self.allowAction:
            await resolve(tab: tab, requestID: requestID, allowed: true)
        case Self.denyAction:
            await resolve(tab: tab, requestID: requestID, allowed: false)
        case UNNotificationDefaultActionIdentifier:
            // Tapping the notification body itself (not an Allow/Deny
            // action): foreground onto the tab it named, past whatever tab
            // was last active. `tab` can legitimately be empty for a
            // malformed/old payload — nothing to link to.
            guard !tab.isEmpty else { return }
            if let bridge {
                await dispatchSwitchTab(tab: tab, requestId: requestID, via: bridge)
            } else {
                // Cold launch: RootView hasn't wired `bridge` yet. Stash it;
                // `bridge`'s didSet flushes as soon as it is.
                pendingSwitch = (tab, requestID)
            }
        default:
            break
        }
    }
}
