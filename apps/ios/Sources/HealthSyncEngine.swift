import Foundation
import HealthKit
import os

/// Device fields for the ingest envelope. Captured on the main actor (UIDevice
/// is main-actor isolated) and handed to the engine as plain strings.
struct HealthDeviceInfo: Sendable {
    let name: String
    let model: String
    let systemVersion: String
}

/// What the engine reports back to `HealthSync`, which owns the status the
/// page sees.
enum HealthSyncEvent: Sendable {
    case started
    case progress(typesDone: Int, typesTotal: Int, samplesSent: Int)
    case finished(HealthSyncOutcome)
}

enum HealthSyncOutcome: Sendable {
    case completed
    case cancelled
    /// HealthKit is unreadable while the phone is locked. Not an error: the
    /// next observer wake or foreground kick retries.
    case deviceLocked
    /// Every type was attempted, but the gateway refused some of them (400 or
    /// a batch still too large at the smallest page). The run still counts as
    /// a sync; the message names the skipped types. Item 7 of the 2026-10-02
    /// review: one bad type must not freeze `lastSyncAt` forever.
    case partial(String)
    case failed(String)
}

/// The serialized worker behind Apple Health sync. Contract:
/// docs/ios-gateway/APPLE-HEALTH.md.
///
/// One drain runs at a time. Requests coalesce into an ordered queue of
/// catalog entries; an observer wake queues its type and waits for just that
/// type. Every step is resumable: per-type anchors and stats
/// dates are written to the App Group defaults only after the gateway
/// answered 200, so a cancelled, killed or failed run resends from the last
/// acknowledged batch.
actor HealthSyncEngine {
    static let log = Logger(subsystem: "dev.henryortega.vaultgateway", category: "health")

    static let ingestPath = "/apple-health/ingest"
    static let sampleBatchLimit = 2000
    static let dailyBatchLimit = 5000

    enum Key {
        static let enabled = "healthEnabled"
        static let lastSyncAt = "healthLastSyncAt"
        static let lastAttemptAt = "healthLastAttemptAt"
        static let lastError = "healthLastError"
        static let totalSamples = "healthTotalSamplesSent"
        static let totalDaily = "healthTotalDailySent"
        static let characteristics = "healthCharacteristicsJSON"
        static func anchor(_ identifier: String) -> String { "healthAnchor.\(identifier)" }
        static func statsDate(_ identifier: String) -> String { "healthStatsDate.\(identifier)" }
        /// Earliest local day whose daily stats are stale (samples added or
        /// deleted there and acknowledged by the gateway, but daily rows not
        /// yet re-sent). Persisted so an interrupted catch-up resumes the
        /// recompute instead of leaving permanent gaps; cleared only after
        /// the last daily chunk is acknowledged.
        static func dailyDirtyFrom(_ identifier: String) -> String { "healthDailyDirtyFrom.\(identifier)" }
    }

    private let store: HKHealthStore
    private let device: HealthDeviceInfo
    private let onEvent: @Sendable (HealthSyncEvent) -> Void
    private var defaults: UserDefaults { GatewayConfig.suite }

    private var pending: [HealthTypes.Entry] = []
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var worker: Task<Void, Never>?
    private var typesDone = 0
    private var typesTotal = 0
    private var runSamples = 0
    /// Types the gateway refused in this drain (short name, reason). The run
    /// still finishes the rest and ends `.partial` rather than `.failed`.
    private var rejected: [(type: String, reason: String)] = []
    /// Bumped for every new drain. A cancelled drain keeps running until its
    /// current step returns; this lets it tell that a newer drain has taken
    /// over the queue, so it must not clear `pending`, resume the new drain's
    /// waiters, or nil out `worker` on its way out.
    private var generation = 0

    private var unitCache: [String: HealthTypes.UnitChoice] = [:]
    private var preferredUnitsLoaded = false

    init(store: HKHealthStore, device: HealthDeviceInfo, onEvent: @escaping @Sendable (HealthSyncEvent) -> Void) {
        self.store = store
        self.device = device
        self.onEvent = onEvent
    }

    // MARK: - Queue

    /// Queues `entries` and starts a drain if none is running. Does not wait.
    func enqueue(_ entries: [HealthTypes.Entry]) {
        var added = 0
        for entry in entries where !pending.contains(entry) {
            pending.append(entry)
            added += 1
        }
        if let current = worker, !current.isCancelled {
            typesTotal += added
            onEvent(.progress(typesDone: typesDone, typesTotal: typesTotal, samplesSent: runSamples))
        } else {
            // No drain, or only a cancelled one still winding down (toggle
            // off then straight back on). Chain a fresh drain behind it
            // rather than handing the new work to a worker that is about to
            // stop, which used to drop the request on the floor.
            let previous = worker
            generation += 1
            let gen = generation
            worker = Task {
                await previous?.value
                await self.drain(gen)
            }
        }
    }

    /// Queues one entry and returns once it has been processed (or the drain
    /// stopped). The observer-query path: HealthKit's completion handler is
    /// called right after this returns. Appended rather than jumped to the
    /// front: observer queries can fire for every type at registration, and
    /// jumping would reverse the catalog's priority order on a first backfill.
    func enqueueAndWait(_ entry: HealthTypes.Entry) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiters[entry.identifier, default: []].append(continuation)
            enqueue([entry])
        }
    }

    /// Stops the running drain after its current step. Everything already
    /// acknowledged stays acknowledged; the rest resumes next time.
    func cancel() {
        worker?.cancel()
        pending.removeAll()
        // Released now rather than when the dying drain unwinds: a newer
        // drain may take over first, and its exit leaves these alone.
        resumeAllWaiters()
    }

    private func resumeWaiters(for identifier: String) {
        for waiter in waiters.removeValue(forKey: identifier) ?? [] { waiter.resume() }
    }

    private func resumeAllWaiters() {
        let all = waiters
        waiters.removeAll()
        for list in all.values { for waiter in list { waiter.resume() } }
    }

    // MARK: - Drain

    private struct Stop: Error {
        let outcome: HealthSyncOutcome
    }

    private func drain(_ gen: Int) async {
        typesDone = 0
        typesTotal = pending.count
        runSamples = 0
        rejected = []
        onEvent(.started)
        // lastAttemptAt is written by HealthSync, and only for runs that
        // completed or failed (item 6): a cancelled or locked run must not
        // hold off the 15-minute foreground catch-up.
        var outcome: HealthSyncOutcome = .completed
        do {
            try checkCancelled()
            try await syncCharacteristicsIfChanged()
            while !pending.isEmpty {
                try checkCancelled()
                let entry = pending.removeFirst()
                do {
                    try await sync(entry)
                } catch let stop as Stop {
                    throw stop
                } catch {
                    // A HealthKit failure scoped to one type (denied, an
                    // unsupported statistics option) skips that type only.
                    if Self.isDatabaseInaccessible(error) { throw Stop(outcome: .deviceLocked) }
                    Self.log.error("skip \(entry.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
                typesDone += 1
                if gen == generation { resumeWaiters(for: entry.identifier) }
                onEvent(.progress(typesDone: typesDone, typesTotal: typesTotal, samplesSent: runSamples))
            }
        } catch let stop as Stop {
            outcome = stop.outcome
        } catch {
            outcome = Task.isCancelled ? .cancelled : .failed(error.localizedDescription)
        }
        // A cancel that lands where nothing throws (during the characteristics
        // step, or with the queue already emptied by cancel()) must never
        // read as a finished sync and stamp lastSyncAt.
        if case .completed = outcome, Task.isCancelled { outcome = .cancelled }
        if case .completed = outcome, !rejected.isEmpty {
            let names = rejected.map(\.type).joined(separator: ", ")
            outcome = .partial("Some types were skipped: \(names). \(rejected[0].reason)")
        }
        if gen == generation {
            pending.removeAll()
            resumeAllWaiters()
            worker = nil
        }
        switch outcome {
        case .completed: Self.log.info("sync complete: \(self.runSamples) samples")
        case .partial(let message): Self.log.error("sync partial: \(message, privacy: .public)")
        case .cancelled: Self.log.info("sync cancelled after \(self.runSamples) samples")
        case .deviceLocked: Self.log.info("sync paused: device locked")
        case .failed(let message): Self.log.error("sync failed: \(message, privacy: .public)")
        }
        onEvent(.finished(outcome))
    }

    private func checkCancelled() throws {
        if Task.isCancelled { throw Stop(outcome: .cancelled) }
    }

    nonisolated static func isDatabaseInaccessible(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == HKErrorDomain && ns.code == HKError.Code.errorDatabaseInaccessible.rawValue
    }

    // MARK: - One type

    private func sync(_ entry: HealthTypes.Entry) async throws {
        guard let type = entry.sampleType else { return }
        var unit: HealthTypes.UnitChoice?
        if let quantityType = type as? HKQuantityType {
            unit = await unitChoice(for: quantityType)
            guard unit != nil else {
                Self.log.error("no compatible unit for \(entry.identifier, privacy: .public); skipped")
                return
            }
        }

        var anchor = loadAnchor(entry.identifier)
        var limit = Self.sampleBatchLimit
        var changed = false
        let formatter = Self.isoFormatter()

        while true {
            try checkCancelled()
            let descriptor = HKAnchoredObjectQueryDescriptor(
                predicates: [.sample(type: type)], anchor: anchor, limit: limit)
            let result = try await descriptor.result(for: store)
            try checkCancelled()
            let added = result.addedSamples
            let deleted = result.deletedObjects
            if added.isEmpty && deleted.isEmpty {
                // Nothing to acknowledge, so the anchor is left where it was.
                // A read-denied type also looks empty, and keeping its anchor
                // unset means granting access later still backfills it all.
                break
            }
            changed = true

            var body = envelope()
            if !added.isEmpty {
                body["samples"] = added.map { sampleDict($0, entry: entry, unit: unit, formatter: formatter) }
            }
            if !deleted.isEmpty {
                body["deleted"] = deleted.map { ["uuid": $0.uuid.uuidString, "type": entry.identifier] }
            }
            switch try await post(body) {
            case .ok(let deletedFrom):
                // Dirty range first, then the anchor: if the app dies between
                // the two, the batch is resent and the range is only widened
                // again, never lost. Added samples dirty their own days; the
                // gateway reports the earliest day of the deletions it
                // applied, so removed samples correct daily stats too.
                if entry.kind == .quantity {
                    markDailyDirty(entry.identifier, from: added.map(\.startDate).min())
                    markDailyDirty(entry.identifier, from: deletedFrom)
                }
                saveAnchor(result.newAnchor, for: entry.identifier)
                anchor = result.newAnchor
                runSamples += added.count
                defaults.set(defaults.integer(forKey: Key.totalSamples) + added.count, forKey: Key.totalSamples)
                onEvent(.progress(typesDone: typesDone, typesTotal: typesTotal, samplesSent: runSamples))
            case .tooLarge:
                // Retry the same anchor with a smaller page; only a single
                // pathological sample could still be too big at 100.
                guard limit > 100 else {
                    rejected.append((Self.shortName(entry.identifier), "A batch is too large for the gateway."))
                    return
                }
                limit = max(100, limit / 4)
                continue
            case .rejected(let message):
                rejected.append((Self.shortName(entry.identifier), "The gateway said: \(message)"))
                return
            }
            if added.count + deleted.count < limit { break }
        }

        if entry.kind == .quantity, let quantityType = type as? HKQuantityType, let unit {
            try await syncDaily(entry: entry, type: quantityType, unit: unit, changed: changed)
        }
    }

    /// Widens the persisted dirty range for `identifier` back to `date`'s
    /// local day. Never narrows it; `syncDaily` clears it once re-sent.
    private func markDailyDirty(_ identifier: String, from date: Date?) {
        guard let date else { return }
        let day = Calendar.current.startOfDay(for: date)
        let key = Key.dailyDirtyFrom(identifier)
        if let stored = defaults.object(forKey: key) as? Date, stored <= day { return }
        defaults.set(day, forKey: key)
    }

    // MARK: - Daily stats

    private func syncDaily(
        entry: HealthTypes.Entry, type: HKQuantityType, unit: HealthTypes.UnitChoice,
        changed: Bool
    ) async throws {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let lastStats = defaults.object(forKey: Key.statsDate(entry.identifier)) as? Date
        // Survives an interrupted run (item 2): a stored value alone is
        // reason enough to recompute, from at least that day.
        let dirtyFrom = defaults.object(forKey: Key.dailyDirtyFrom(entry.identifier)) as? Date

        let start: Date
        if let lastStats {
            // Nothing new since the last stats pass means no day can differ.
            guard changed || dirtyFrom != nil else { return }
            let window = calendar.date(byAdding: .day, value: -2, to: lastStats) ?? lastStats
            start = min(window, dirtyFrom ?? window)
        } else {
            let first = HKSampleQueryDescriptor(
                predicates: [.quantitySample(type: type)],
                sortDescriptors: [SortDescriptor(\.startDate, order: .forward)],
                limit: 1)
            if let earliest = try await first.result(for: store).first?.startDate {
                start = min(earliest, dirtyFrom ?? earliest)
            } else if let dirtyFrom {
                // Everything was deleted before a first stats pass finished:
                // still overwrite whatever rows an earlier attempt sent.
                start = dirtyFrom
            } else {
                // No samples at all: remember that, so an empty type costs one
                // anchored query per run instead of a sample query too.
                defaults.set(today, forKey: Key.statsDate(entry.identifier))
                return
            }
        }
        try checkCancelled()

        let startDay = calendar.startOfDay(for: start)
        let cumulative = type.aggregationStyle == .cumulative
        let options: HKStatisticsOptions = cumulative
            ? .cumulativeSum
            : [.discreteAverage, .discreteMin, .discreteMax, .mostRecent]
        let descriptor = HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: startDay, end: nil)),
            options: options,
            anchorDate: today,
            intervalComponents: DateComponents(day: 1))
        let collection = try await descriptor.result(for: store)
        try checkCancelled()

        let dayFormatter = Self.dayFormatter()
        let u = unit.unit
        func number(_ quantity: HKQuantity?) -> Any {
            guard let quantity, quantity.is(compatibleWith: u) else { return NSNull() }
            let value = quantity.doubleValue(for: u)
            return value.isFinite ? value : NSNull()
        }
        // Item 3: once a stats pass has run (or deletions dirtied the type),
        // the gateway may hold rows for days that are now empty, so every day
        // in the window is sent and an empty one goes as an all-null row that
        // overwrites the stale values. A type's first pass over its full
        // history has nothing to overwrite and sends only days with data,
        // which keeps a sparse type (weekly weigh-ins over years) from
        // shipping thousands of null rows.
        let sendEmptyDays = lastStats != nil || dirtyFrom != nil
        var rows: [[String: Any]] = []
        var day = startDay
        while day <= today {
            let stats = collection.statistics(for: day)
            let row: [String: Any] = [
                "date": dayFormatter.string(from: day),
                "type": entry.identifier,
                "unit": unit.label,
                "sum": cumulative ? number(stats?.sumQuantity()) : NSNull(),
                "avg": cumulative ? NSNull() : number(stats?.averageQuantity()),
                "min": cumulative ? NSNull() : number(stats?.minimumQuantity()),
                "max": cumulative ? NSNull() : number(stats?.maximumQuantity()),
                "mostRecent": cumulative ? NSNull() : number(stats?.mostRecentQuantity()),
            ]
            let hasValue = ["sum", "avg", "min", "max", "mostRecent"].contains { !(row[$0] is NSNull) }
            if hasValue || sendEmptyDays { rows.append(row) }
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            day = next
        }

        var offset = 0
        while offset < rows.count {
            try checkCancelled()
            let chunk = Array(rows[offset..<min(offset + Self.dailyBatchLimit, rows.count)])
            var body = envelope()
            body["daily"] = chunk
            switch try await post(body) {
            case .ok:
                defaults.set(defaults.integer(forKey: Key.totalDaily) + chunk.count, forKey: Key.totalDaily)
            case .tooLarge:
                rejected.append((Self.shortName(entry.identifier), "Its daily totals are too large for the gateway."))
                return
            case .rejected(let message):
                rejected.append((Self.shortName(entry.identifier), "The gateway said: \(message)"))
                return
            }
            offset += chunk.count
        }
        // Every chunk acknowledged: the stale range is now correct upstream.
        defaults.set(today, forKey: Key.statsDate(entry.identifier))
        defaults.removeObject(forKey: Key.dailyDirtyFrom(entry.identifier))
    }

    // MARK: - Characteristics

    /// Sent on the first sync and whenever any value changes. Skipped
    /// outright if the store is locked, so a locked read never overwrites real
    /// values on the server with nulls.
    private func syncCharacteristicsIfChanged() async throws {
        var dict: [String: Any] = [:]
        func read<T>(_ body: () throws -> T) throws -> T? {
            do { return try body() } catch {
                if Self.isDatabaseInaccessible(error) { throw Stop(outcome: .deviceLocked) }
                return nil
            }
        }
        let dob = try read { try store.dateOfBirthComponents() }
        if let dob, let year = dob.year, let month = dob.month, let day = dob.day {
            dict["dateOfBirth"] = String(format: "%04d-%02d-%02d", year, month, day)
        } else {
            dict["dateOfBirth"] = NSNull()
        }
        switch try read({ try store.biologicalSex().biologicalSex }) {
        case .female?: dict["biologicalSex"] = "female"
        case .male?: dict["biologicalSex"] = "male"
        case .other?: dict["biologicalSex"] = "other"
        default: dict["biologicalSex"] = NSNull()
        }
        let blood: [HKBloodType: String] = [
            .aPositive: "A+", .aNegative: "A-", .bPositive: "B+", .bNegative: "B-",
            .abPositive: "AB+", .abNegative: "AB-", .oPositive: "O+", .oNegative: "O-",
        ]
        dict["bloodType"] = (try read({ try store.bloodType().bloodType })).flatMap { blood[$0] } ?? NSNull()
        let skin: [HKFitzpatrickSkinType: String] = [
            .I: "I", .II: "II", .III: "III", .IV: "IV", .V: "V", .VI: "VI",
        ]
        dict["fitzpatrickSkinType"] = (try read({ try store.fitzpatrickSkinType().skinType })).flatMap { skin[$0] } ?? NSNull()
        switch try read({ try store.wheelchairUse().wheelchairUse }) {
        case .yes?: dict["wheelchairUse"] = true
        case .no?: dict["wheelchairUse"] = false
        default: dict["wheelchairUse"] = NSNull()
        }

        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else { return }
        guard json != defaults.string(forKey: Key.characteristics) else { return }
        var body = envelope()
        body["characteristics"] = dict
        if case .ok = try await post(body) {
            defaults.set(json, forKey: Key.characteristics)
        }
    }

    // MARK: - Serialization

    private func envelope() -> [String: Any] {
        [
            "schema": 1,
            "batchId": UUID().uuidString,
            "device": [
                "name": device.name,
                "model": device.model,
                "systemVersion": device.systemVersion,
                "timeZone": TimeZone.current.identifier,
            ],
        ]
    }

    private func sampleDict(
        _ sample: HKSample, entry: HealthTypes.Entry, unit: HealthTypes.UnitChoice?,
        formatter: ISO8601DateFormatter
    ) -> [String: Any] {
        let revision = sample.sourceRevision
        var dict: [String: Any] = [
            "uuid": sample.uuid.uuidString,
            "kind": entry.kind.rawValue,
            "type": entry.identifier,
            "start": formatter.string(from: sample.startDate),
            "end": formatter.string(from: sample.endDate),
            "value": NSNull(),
            "unit": NSNull(),
            "category": NSNull(),
            "categoryLabel": NSNull(),
            "source": [
                "name": revision.source.name,
                "bundleId": revision.source.bundleIdentifier,
                "version": revision.version ?? NSNull(),
            ] as [String: Any],
            "deviceName": sample.device?.name ?? NSNull(),
            "deviceModel": sample.device?.model ?? NSNull(),
            "metadata": Self.stringify(sample.metadata, formatter: formatter),
            "workout": NSNull(),
        ]
        if let quantitySample = sample as? HKQuantitySample, let unit,
           quantitySample.quantity.is(compatibleWith: unit.unit) {
            let value = quantitySample.quantity.doubleValue(for: unit.unit)
            if value.isFinite {
                dict["value"] = value
                dict["unit"] = unit.label
            }
        } else if let categorySample = sample as? HKCategorySample {
            dict["category"] = categorySample.value
            dict["categoryLabel"] = HealthTypes.categoryLabel(
                identifier: entry.identifier, value: categorySample.value) ?? NSNull()
        } else if let workout = sample as? HKWorkout {
            dict["workout"] = Self.workoutDict(workout)
        }
        return dict
    }

    private static let countPerMinute = HKUnit.count().unitDivided(by: .minute())

    private static func workoutDict(_ workout: HKWorkout) -> [String: Any] {
        func finite(_ value: Double?) -> Any {
            guard let value, value.isFinite else { return NSNull() }
            return value
        }
        let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?
            .sumQuantity()?.doubleValue(for: .kilocalorie())
        var distance: Double?
        for identifier in HealthTypes.workoutDistanceIdentifiers {
            guard let type = HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: identifier)),
                  let sum = workout.statistics(for: type)?.sumQuantity()
            else { continue }
            distance = sum.doubleValue(for: .mile())
            break
        }
        let heartRate = workout.statistics(for: HKQuantityType(.heartRate))
        let indoor = (workout.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber)?.boolValue
        return [
            "activityType": Int(workout.workoutActivityType.rawValue),
            "activityName": HealthTypes.activityName(workout.workoutActivityType),
            "durationSec": finite(workout.duration),
            "energyKcal": finite(energy),
            "distanceMi": finite(distance),
            "avgHeartRate": finite(heartRate?.averageQuantity()?.doubleValue(for: countPerMinute)),
            "maxHeartRate": finite(heartRate?.maximumQuantity()?.doubleValue(for: countPerMinute)),
            "isIndoor": indoor.map { $0 as Any } ?? NSNull(),
        ]
    }

    /// Metadata values stringified per the contract: numbers as their plain
    /// string ("1" for a true flag), dates as ISO 8601, quantities as their
    /// HealthKit description ("23 degC").
    private static func stringify(_ metadata: [String: Any]?, formatter: ISO8601DateFormatter) -> Any {
        guard let metadata, !metadata.isEmpty else { return NSNull() }
        var out: [String: String] = [:]
        for (key, value) in metadata {
            switch value {
            case let string as String: out[key] = string
            case let number as NSNumber: out[key] = number.stringValue
            case let date as Date: out[key] = formatter.string(from: date)
            case let quantity as HKQuantity: out[key] = quantity.description
            default: out[key] = String(describing: value)
            }
        }
        return out
    }

    static func isoFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }

    private static func dayFormatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    static func shortName(_ identifier: String) -> String {
        for prefix in ["HKQuantityTypeIdentifier", "HKCategoryTypeIdentifier"] where identifier.hasPrefix(prefix) {
            return String(identifier.dropFirst(prefix.count))
        }
        return identifier == HealthTypes.workoutIdentifier ? "Workouts" : identifier
    }

    // MARK: - Units

    private func unitChoice(for type: HKQuantityType) async -> HealthTypes.UnitChoice? {
        let identifier = type.identifier
        if let cached = unitCache[identifier] { return cached }
        if let contract = HealthTypes.contractUnit(for: identifier), type.is(compatibleWith: contract.unit) {
            unitCache[identifier] = contract
            return contract
        }
        if !preferredUnitsLoaded {
            preferredUnitsLoaded = true
            let types = Set(HealthTypes.available.compactMap { $0.quantityType })
            do {
                let preferred = try await store.preferredUnits(for: types)
                for (quantityType, unit) in preferred where unitCache[quantityType.identifier] == nil {
                    if quantityType.is(compatibleWith: unit) {
                        unitCache[quantityType.identifier] = .init(unit: unit, label: unit.unitString)
                    }
                }
            } catch {
                Self.log.error("preferredUnits failed: \(error.localizedDescription, privacy: .public)")
            }
            if let cached = unitCache[identifier] { return cached }
        }
        guard let fallback = HealthTypes.fallbackUnits.first(where: { type.is(compatibleWith: $0) }) else {
            return nil
        }
        let choice = HealthTypes.UnitChoice(unit: fallback, label: fallback.unitString)
        unitCache[identifier] = choice
        return choice
    }

    // MARK: - Anchors

    private func loadAnchor(_ identifier: String) -> HKQueryAnchor? {
        guard let data = defaults.data(forKey: Key.anchor(identifier)) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor, for identifier: String) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        defaults.set(data, forKey: Key.anchor(identifier))
    }

    // MARK: - Upload

    private enum PostResult {
        /// `deletedFrom`: the gateway's `deletedFrom` ("YYYY-MM-DD" or null),
        /// the earliest local day among the deleted samples it actually held.
        case ok(deletedFrom: Date?)
        case tooLarge
        case rejected(String)
    }

    /// One ingest POST. Batch-specific answers (413, 400) come back as a
    /// result so the caller can shrink or skip; anything that will fail for
    /// every batch alike (unreachable, unauthorized, 5xx) stops the drain.
    private func post(_ body: [String: Any]) async throws -> PostResult {
        guard JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body)
        else { return .rejected("the batch could not be encoded") }
        let outcome = await GatewayClient.upload(path: Self.ingestPath, json: data)
        try checkCancelled()
        switch outcome {
        case .http(let status, let data):
            switch status {
            case 200:
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                let deletedFrom = (json?["deletedFrom"] as? String).flatMap { Self.dayFormatter().date(from: $0) }
                return .ok(deletedFrom: deletedFrom)
            case 413:
                return .tooLarge
            case 400:
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                return .rejected(json?["message"] as? String ?? json?["error"] as? String ?? "bad payload")
            case 401, 403:
                throw Stop(outcome: .failed("The gateway rejected the token."))
            case 404:
                throw Stop(outcome: .failed("The gateway has no Apple Health route. Update the gateway on the Mac."))
            case 503:
                throw Stop(outcome: .failed("The gateway is starting up."))
            default:
                throw Stop(outcome: .failed("The gateway answered HTTP \(status)."))
            }
        case .failure(let failure, let message):
            throw Stop(outcome: .failed(Self.describe(failure, message: message)))
        }
    }

    private static func describe(_ failure: GatewayClient.Failure, message: String) -> String {
        switch failure {
        case .cannotFindHost: return "Tailscale isn't connected."
        case .timedOut: return "The Mac didn't answer in time."
        case .refused: return "The vault gateway isn't running."
        case .tlsError: return "HTTPS certificate problem."
        case .other: return message
        }
    }
}
