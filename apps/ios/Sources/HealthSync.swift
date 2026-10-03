import Foundation
import HealthKit
import UIKit

/// Apple Health sync: the main-actor face of `HealthSyncEngine`. Owns the
/// enabled flag, the HealthKit observer queries and background delivery, the
/// `HealthStatus` the page sees, and the `healthSync` dispatch. Contract:
/// docs/ios-gateway/APPLE-HEALTH.md.
///
/// Every piece of state lives in the App Group defaults (never the page's
/// localStorage), so a background-delivery relaunch with no UI reads exactly
/// what the foreground app wrote.
@MainActor
final class HealthSync {
    static let shared = HealthSync()

    /// Set by RootView once the web view exists; nil during a background
    /// relaunch, when there is no page to tell.
    weak var bridge: NativeBridge? {
        didSet { if bridge != nil { push() } }
    }

    private typealias Key = HealthSyncEngine.Key
    private static let foregroundInterval: TimeInterval = 15 * 60

    private let store = HKHealthStore()
    /// Engine events reach the main actor through one ordered stream (item 5
    /// of the 2026-10-02 review). A Task per event gave no ordering, so an
    /// old drain's `.finished` could land after the next drain's `.started`,
    /// leaving that drain without a background task and the UI idle.
    private let eventSink: AsyncStream<HealthSyncEvent>.Continuation
    private lazy var engine = HealthSyncEngine(
        store: store,
        device: HealthDeviceInfo(
            name: UIDevice.current.name,
            model: UIDevice.current.model,
            systemVersion: UIDevice.current.systemVersion),
        onEvent: { [eventSink = self.eventSink] event in eventSink.yield(event) })

    private var observers: [HKObserverQuery] = []
    private var syncing = false
    private var progress: (typesDone: Int, typesTotal: Int, samplesSent: Int)?
    private let activity = BackgroundActivity()

    private var defaults: UserDefaults { GatewayConfig.suite }

    private init() {
        let (events, sink) = AsyncStream.makeStream(of: HealthSyncEvent.self)
        eventSink = sink
        Task { @MainActor [weak self] in
            for await event in events { self?.handle(event) }
        }
        activity.onExpire = { [weak self] in
            // Synchronously, before the background task ends (item 1): every
            // HealthKit wake still waiting on the queue gets its completion
            // now, inside the window, or HealthKit backs off and eventually
            // stops background delivery. The drain itself is resumable.
            ObserverCompletion.callAllPending()
            guard let self else { return }
            Task { await self.engine.cancel() }
        }
    }

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    var isEnabled: Bool { isAvailable && defaults.bool(forKey: Key.enabled) }

    // MARK: - Launch and foreground

    /// From `didFinishLaunching`. A background-delivery wake relaunches the
    /// app without UI and HealthKit only redelivers to queries that exist by
    /// the time launch finishes, so this must run there, every launch.
    func registerAtLaunch() {
        guard isEnabled else { return }
        startObservers()
    }

    /// From RootView's `.active`: catch up when the last sync is stale.
    func syncIfStale() {
        guard isEnabled else { return }
        let last = [defaults.object(forKey: Key.lastSyncAt) as? Date,
                    defaults.object(forKey: Key.lastAttemptAt) as? Date]
            .compactMap { $0 }.max()
        if let last, Date().timeIntervalSince(last) < Self.foregroundInterval { return }
        startSync()
    }

    // MARK: - Bridge methods

    func status() -> [String: Any] {
        var payload: [String: Any] = [
            "available": isAvailable,
            "enabled": isEnabled,
            "syncing": syncing,
            "lastSyncAt": (defaults.object(forKey: Key.lastSyncAt) as? Date)
                .map { HealthSyncEngine.isoFormatter().string(from: $0) } ?? NSNull(),
            "lastError": defaults.string(forKey: Key.lastError) ?? NSNull(),
            "totals": [
                "samplesSent": defaults.integer(forKey: Key.totalSamples),
                "dailySent": defaults.integer(forKey: Key.totalDaily),
            ],
        ]
        if syncing, let progress {
            payload["progress"] = [
                "typesDone": progress.typesDone,
                "typesTotal": progress.typesTotal,
                "samplesSent": progress.samplesSent,
            ]
        } else {
            payload["progress"] = NSNull()
        }
        return payload
    }

    /// Enabling asks for read authorization first (the system sheet; the
    /// reply waits for it), then starts the observers and a full sync.
    func setEnabled(_ enabled: Bool) async -> [String: Any] {
        guard isAvailable else { return status() }
        if enabled {
            do {
                try await requestReadAuthorization()
            } catch {
                HealthSyncEngine.log.error("authorization failed: \(error.localizedDescription, privacy: .public)")
                defaults.set("Health access request failed: \(error.localizedDescription)", forKey: Key.lastError)
                push()
                return status()
            }
            defaults.set(true, forKey: Key.enabled)
            defaults.removeObject(forKey: Key.lastError)
            startObservers()
            startSync()
        } else {
            defaults.set(false, forKey: Key.enabled)
            stopObservers()
            await engine.cancel()
            push()
        }
        return status()
    }

    /// Asks for read access to the whole catalog. HealthKit raises an
    /// exception (fatal from Swift) when one type in the set may not be read;
    /// the Objective-C shim catches it, the refused identifiers named in the
    /// reason are dropped for good, and the request is retried.
    private func requestReadAuthorization() async throws {
        for _ in 0..<5 {
            let outcome = await withCheckedContinuation { (cont: CheckedContinuation<AuthOutcome, Never>) in
                let once = ResumeOnce(cont)
                let refusal = VGHealthAuthorization.requestReadAuthorization(
                    with: store, types: HealthTypes.readSet
                ) { _, error in
                    once.resume(error.map { .failed($0) } ?? .granted)
                }
                if let refusal { once.resume(.refused(refusal)) }
            }
            switch outcome {
            case .granted:
                return
            case .failed(let error):
                throw error
            case .refused(let reason):
                let named = Self.identifiers(in: reason)
                HealthSyncEngine.log.error("authorization refused: \(reason, privacy: .public)")
                guard !named.isEmpty, !named.isSubset(of: HealthTypes.disallowed) else {
                    throw HealthAuthError(reason: reason)
                }
                HealthTypes.disallowed.formUnion(named)
            }
        }
        throw HealthAuthError(reason: "Health kept refusing the read set after dropping types.")
    }

    private static func identifiers(in reason: String) -> Set<String> {
        guard let regex = try? NSRegularExpression(pattern: "HK[A-Za-z]+TypeIdentifier[A-Za-z0-9]+") else { return [] }
        let range = NSRange(reason.startIndex..., in: reason)
        return Set(regex.matches(in: reason, range: range).compactMap {
            Range($0.range, in: reason).map { String(reason[$0]) }
        })
    }

    private enum AuthOutcome { case granted, failed(Error), refused(String) }

    private struct HealthAuthError: LocalizedError {
        let reason: String
        var errorDescription: String? { reason }
    }

    /// Guards the continuation against a double resume, in case HealthKit
    /// ever both raises and calls back.
    private final class ResumeOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var cont: CheckedContinuation<AuthOutcome, Never>?
        init(_ cont: CheckedContinuation<AuthOutcome, Never>) { self.cont = cont }
        func resume(_ outcome: AuthOutcome) {
            lock.lock()
            let c = cont
            cont = nil
            lock.unlock()
            c?.resume(returning: outcome)
        }
    }

    /// Starts a sync of every type and returns at once; progress arrives via
    /// the `healthSync` dispatch.
    func syncNow() -> [String: Any] {
        if isEnabled { startSync() }
        return status()
    }

    private func startSync() {
        let entries = HealthTypes.available
        Task { await engine.enqueue(entries) }
    }

    // MARK: - Engine events

    private var drainToken: BackgroundActivity.Token?

    private func handle(_ event: HealthSyncEvent) {
        switch event {
        case .started:
            syncing = true
            progress = nil
            // Covers a foreground sync the user walks away from as well as an
            // observer wake: either way iOS grants the drain its background
            // window, and expiry cancels it (anchors make that resumable).
            if drainToken == nil { drainToken = activity.begin() }
        case .progress(let done, let total, let samples):
            progress = (done, total, samples)
        case .finished(let outcome):
            syncing = false
            progress = nil
            // lastAttemptAt only for runs that actually ran to an answer
            // (item 6): a cancelled or locked run must not suppress the
            // 15-minute foreground catch-up in syncIfStale.
            switch outcome {
            case .completed:
                defaults.set(Date(), forKey: Key.lastSyncAt)
                defaults.set(Date(), forKey: Key.lastAttemptAt)
                defaults.removeObject(forKey: Key.lastError)
            case .partial(let message):
                // Item 7: every type was attempted, so this is a sync; the
                // refused types are surfaced, not treated as a failed run.
                defaults.set(Date(), forKey: Key.lastSyncAt)
                defaults.set(Date(), forKey: Key.lastAttemptAt)
                defaults.set(message, forKey: Key.lastError)
            case .failed(let message):
                defaults.set(Date(), forKey: Key.lastAttemptAt)
                defaults.set("Sync failed: \(message)", forKey: Key.lastError)
            case .cancelled, .deviceLocked:
                break
            }
            if let token = drainToken {
                drainToken = nil
                activity.end(token)
            }
        }
        push()
    }

    private func push() {
        bridge?.dispatch("healthSync", status())
    }

    // MARK: - Observers and background delivery

    private func startObservers() {
        guard observers.isEmpty else { return }
        for entry in HealthTypes.available {
            guard let type = entry.sampleType else { continue }
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                if let error {
                    HealthSyncEngine.log.error("observer \(entry.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    completion()
                    return
                }
                // Item 1: the completion runs at whichever comes first: this
                // type synced, a 20 s deadline (the wake's background window
                // is about 30 s, and a full drain on relaunch can take far
                // longer), or background-task expiry (callAllPending). The
                // sync itself carries on; its anchors make that safe.
                let done = ObserverCompletion(completion)
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + ObserverCompletion.deadline) {
                    done.call()
                }
                Task { @MainActor in
                    await HealthSync.shared.observerFired(entry)
                    done.call()
                }
            }
            store.execute(query)
            observers.append(query)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { ok, error in
                if !ok, let error {
                    HealthSyncEngine.log.error("background delivery \(entry.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        HealthSyncEngine.log.info("observing \(self.observers.count) Health types")
    }

    private func stopObservers() {
        for query in observers { store.stop(query) }
        observers.removeAll()
        store.disableAllBackgroundDelivery { ok, error in
            if !ok, let error {
                HealthSyncEngine.log.error("disable background delivery: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// An observer wake syncs just that type, inside a background task, and
    /// returns once it is done (or the drain stopped). HealthKit's completion
    /// handler is called by the observer callback at the first of: this
    /// returning, the 20 s deadline, or background expiry. Skipping that call
    /// makes HealthKit back off delivery, so every path ends in it.
    private func observerFired(_ entry: HealthTypes.Entry) async {
        guard isEnabled else { return }
        let token = activity.begin()
        await engine.enqueueAndWait(entry)
        activity.end(token)
    }
}

/// Carries HealthKit's observer completion handler across the hop to the
/// main actor. Call-once: the sync finishing, the deadline and background
/// expiry all race to call it. Every live instance is also tracked in a
/// lock-guarded registry (registered synchronously on HealthKit's queue, no
/// actor hop) so expiry can flush all of them at once.
private final class ObserverCompletion: @unchecked Sendable {
    static let deadline: TimeInterval = 20

    private static let lock = NSLock()
    private static var pending: [ObjectIdentifier: ObserverCompletion] = [:]

    private var handler: (() -> Void)?

    init(_ handler: @escaping () -> Void) {
        self.handler = handler
        Self.lock.lock()
        Self.pending[ObjectIdentifier(self)] = self
        Self.lock.unlock()
    }

    func call() {
        Self.lock.lock()
        let run = handler
        handler = nil
        Self.pending.removeValue(forKey: ObjectIdentifier(self))
        Self.lock.unlock()
        run?()
    }

    static func callAllPending() {
        lock.lock()
        let all = Array(pending.values)
        lock.unlock()
        for completion in all { completion.call() }
    }
}

/// One `UIApplication` background task shared by every concurrent holder (a
/// running drain plus any observer wakes waiting on it). Expiry cancels the
/// work through `onExpire` and invalidates every outstanding token, so a late
/// `end` from a holder that outlived it cannot end a newer task.
@MainActor
final class BackgroundActivity {
    struct Token {
        fileprivate let generation: Int
    }

    var onExpire: (() -> Void)?

    private var generation = 0
    private var holders = 0
    private var task: UIBackgroundTaskIdentifier = .invalid

    func begin() -> Token {
        if task == .invalid {
            generation += 1
            holders = 0
            task = UIApplication.shared.beginBackgroundTask(withName: "AppleHealthSync") { [weak self] in
                MainActor.assumeIsolated { self?.expire() }
            }
        }
        holders += 1
        return Token(generation: generation)
    }

    func end(_ token: Token) {
        guard token.generation == generation, task != .invalid else { return }
        holders -= 1
        if holders <= 0 { finish() }
    }

    private func expire() {
        HealthSyncEngine.log.info("background time expired; pausing Health sync")
        onExpire?()
        finish()
    }

    private func finish() {
        guard task != .invalid else { return }
        let ending = task
        task = .invalid
        holders = 0
        UIApplication.shared.endBackgroundTask(ending)
    }
}
