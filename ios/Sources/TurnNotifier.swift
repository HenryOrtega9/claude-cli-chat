import Foundation
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
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    // MARK: - Arming

    /// Arm a wait for the most recently busy tab recorded by `setState`.
    /// No-op when nothing is busy or no token is enrolled.
    @discardableResult
    func armFromPersistedState() -> Bool {
        let suite = GatewayConfig.suite
        let busy = suite.stringArray(forKey: GatewayConfig.Key.busyTabs) ?? []
        guard !busy.isEmpty, GatewayConfig.hasToken else { return false }
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
            return
        }
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        )
    }

    private func tabTitle(for tab: String) -> String {
        let titles = GatewayConfig.suite.dictionary(forKey: GatewayConfig.Key.tabTitles) as? [String: String]
        if let title = titles?[tab], !title.isEmpty { return title }
        return tab.isEmpty ? "Your vault chat" : "Tab \(tab.prefix(8))"
    }

    private func resolve(tab: String, requestID: String, allowed: Bool) async {
        guard !tab.isEmpty, !requestID.isEmpty else { return }
        _ = await GatewayClient.send(
            path: "/tabs/\(tab)/approve",
            method: "POST",
            body: [
                "request_id": requestID,
                "allowed": allowed,
                "reason": allowed ? "Allowed from a notification" : "Denied from a notification",
            ]
        )
    }
}

extension TurnNotifier: URLSessionDownloadDelegate {
    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let data = try? Data(contentsOf: location),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        notify(frame: frame, tabHint: downloadTask.taskDescription)
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
        default:
            break
        }
    }
}
