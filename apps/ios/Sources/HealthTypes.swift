import Foundation
import HealthKit

/// The HealthKit type catalog, the unit map and the human labels that
/// HealthSync uploads. Wire format: docs/ios-gateway/APPLE-HEALTH.md.
///
/// Identifiers are kept as raw strings (the SDK's own constant values, minus
/// the `HKQuantityTypeIdentifier` / `HKCategoryTypeIdentifier` prefix) and
/// resolved through the optional `HKObjectType` factories at runtime, so an
/// identifier newer than the running OS resolves to nil instead of trapping.
/// Anything newer than the iOS 18.0 deployment target also carries `minOS`
/// and is skipped on older systems before HealthKit is ever asked about it.
///
/// Deliberately absent: clinical records, ECG (`HKElectrocardiogramType`),
/// audiograms, workout routes, State of Mind, correlations (blood pressure
/// and food arrive through their component quantity types), the deprecated
/// `AudioExposureEvent`, and `NikeFuel`, whose read authorization HealthKit
/// rejects with an exception.
enum HealthTypes {
    enum Kind: String {
        case quantity, category, workout
    }

    struct Entry: Hashable {
        let kind: Kind
        /// Full HealthKit identifier, e.g. "HKQuantityTypeIdentifierStepCount".
        let identifier: String
        let minOS: OperatingSystemVersion?

        static func == (a: Entry, b: Entry) -> Bool { a.identifier == b.identifier }
        func hash(into hasher: inout Hasher) { hasher.combine(identifier) }

        var sampleType: HKSampleType? {
            if let minOS, !ProcessInfo.processInfo.isOperatingSystemAtLeast(minOS) { return nil }
            switch kind {
            case .quantity:
                return HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: identifier))
            case .category:
                return HKObjectType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: identifier))
            case .workout:
                return HKObjectType.workoutType()
            }
        }

        var quantityType: HKQuantityType? { sampleType as? HKQuantityType }
    }

    private struct Row {
        let name: String
        let minOS: (Int, Int)?
        init(_ name: String, minOS: (Int, Int)? = nil) {
            self.name = name
            self.minOS = minOS
        }
    }

    static let workoutIdentifier = "HKWorkoutTypeIdentifier"

    /// The ones the vault note and the weekly CSV lean on, synced first so a
    /// long first-run backfill produces a useful note early.
    private static let priority: [String] = [
        "HKQuantityTypeIdentifierBodyMass",
        "HKQuantityTypeIdentifierBodyFatPercentage",
        "HKQuantityTypeIdentifierLeanBodyMass",
        "HKQuantityTypeIdentifierRestingHeartRate",
        "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        "HKQuantityTypeIdentifierVO2Max",
        "HKQuantityTypeIdentifierActiveEnergyBurned",
        "HKQuantityTypeIdentifierBasalEnergyBurned",
        "HKCategoryTypeIdentifierSleepAnalysis",
        workoutIdentifier,
        "HKQuantityTypeIdentifierStepCount",
    ]

    /// Every readable quantity type in the iOS 27 SDK headers (HKTypeIdentifiers.h).
    private static let quantityRows: [Row] = [
        .init("AppleSleepingWristTemperature"),
        .init("BodyFatPercentage"),
        .init("BodyMass"),
        .init("BodyMassIndex"),
        .init("ElectrodermalActivity"),
        .init("Height"),
        .init("LeanBodyMass"),
        .init("WaistCircumference"),
        .init("ActiveEnergyBurned"),
        .init("AppleExerciseTime"),
        .init("AppleMoveTime"),
        .init("AppleStandTime"),
        .init("BasalEnergyBurned"),
        .init("CrossCountrySkiingSpeed"),
        .init("CyclingCadence"),
        .init("CyclingFunctionalThresholdPower"),
        .init("CyclingPower"),
        .init("CyclingSpeed"),
        .init("DistanceCrossCountrySkiing"),
        .init("DistanceCycling"),
        .init("DistanceDownhillSnowSports"),
        .init("DistancePaddleSports"),
        .init("DistanceRowing"),
        .init("DistanceSkatingSports"),
        .init("DistanceSwimming"),
        .init("DistanceWalkingRunning"),
        .init("DistanceWheelchair"),
        .init("EstimatedWorkoutEffortScore"),
        .init("FlightsClimbed"),
        .init("PaddleSportsSpeed"),
        .init("PhysicalEffort"),
        .init("PushCount"),
        .init("RowingSpeed"),
        .init("RunningPower"),
        .init("RunningSpeed"),
        .init("StepCount"),
        .init("SwimmingStrokeCount"),
        .init("UnderwaterDepth"),
        .init("WorkoutEffortScore"),
        .init("EnvironmentalAudioExposure"),
        .init("EnvironmentalSoundReduction"),
        .init("HeadphoneAudioExposure"),
        .init("AtrialFibrillationBurden"),
        .init("HeartRate"),
        .init("HeartRateRecoveryOneMinute"),
        .init("HeartRateVariabilityRMSSD", minOS: (27, 0)),
        .init("HeartRateVariabilitySDNN"),
        .init("PeripheralPerfusionIndex"),
        .init("RestingHeartRate"),
        .init("VO2Max"),
        .init("WalkingHeartRateAverage"),
        .init("AppleWalkingSteadiness"),
        .init("RunningGroundContactTime"),
        .init("RunningStrideLength"),
        .init("RunningVerticalOscillation"),
        .init("SixMinuteWalkTestDistance"),
        .init("StairAscentSpeed"),
        .init("StairDescentSpeed"),
        .init("WalkingAsymmetryPercentage"),
        .init("WalkingDoubleSupportPercentage"),
        .init("WalkingSpeed"),
        .init("WalkingStepLength"),
        .init("DietaryBiotin"),
        .init("DietaryCaffeine"),
        .init("DietaryCalcium"),
        .init("DietaryCarbohydrates"),
        .init("DietaryChloride"),
        .init("DietaryCholesterol"),
        .init("DietaryChromium"),
        .init("DietaryCopper"),
        .init("DietaryEnergyConsumed"),
        .init("DietaryFatMonounsaturated"),
        .init("DietaryFatPolyunsaturated"),
        .init("DietaryFatSaturated"),
        .init("DietaryFatTotal"),
        .init("DietaryFiber"),
        .init("DietaryFolate"),
        .init("DietaryIodine"),
        .init("DietaryIron"),
        .init("DietaryMagnesium"),
        .init("DietaryManganese"),
        .init("DietaryMolybdenum"),
        .init("DietaryNiacin"),
        .init("DietaryPantothenicAcid"),
        .init("DietaryPhosphorus"),
        .init("DietaryPotassium"),
        .init("DietaryProtein"),
        .init("DietaryRiboflavin"),
        .init("DietarySelenium"),
        .init("DietarySodium"),
        .init("DietarySugar"),
        .init("DietaryThiamin"),
        .init("DietaryVitaminA"),
        .init("DietaryVitaminB12"),
        .init("DietaryVitaminB6"),
        .init("DietaryVitaminC"),
        .init("DietaryVitaminD"),
        .init("DietaryVitaminE"),
        .init("DietaryVitaminK"),
        .init("DietaryWater"),
        .init("DietaryZinc"),
        .init("BloodAlcoholContent"),
        .init("BloodPressureDiastolic"),
        .init("BloodPressureSystolic"),
        .init("InsulinDelivery"),
        .init("NumberOfAlcoholicBeverages"),
        .init("NumberOfTimesFallen"),
        .init("TimeInDaylight"),
        .init("UVExposure"),
        .init("WaterTemperature"),
        .init("BasalBodyTemperature"),
        .init("AppleSleepingBreathingDisturbances"),
        .init("ForcedExpiratoryVolume1"),
        .init("ForcedVitalCapacity"),
        .init("InhalerUsage"),
        .init("OxygenSaturation"),
        .init("PeakExpiratoryFlowRate"),
        .init("RespiratoryRate"),
        .init("BloodGlucose"),
        .init("BodyTemperature"),
    ]

    /// Every readable category type in the iOS 27 SDK headers.
    private static let categoryRows: [Row] = [
        .init("AppleStandHour"),
        .init("EnvironmentalAudioExposureEvent"),
        .init("HeadphoneAudioExposureEvent"),
        .init("HighHeartRateEvent"),
        .init("HypertensionEvent", minOS: (26, 2)),
        .init("IrregularHeartRhythmEvent"),
        .init("LowCardioFitnessEvent"),
        .init("LowHeartRateEvent"),
        .init("MindfulSession"),
        .init("AppleWalkingSteadinessEvent"),
        .init("HandwashingEvent"),
        .init("ToothbrushingEvent"),
        .init("BleedingAfterMenopause", minOS: (27, 0)),
        .init("BleedingAfterPregnancy"),
        .init("BleedingDuringPregnancy"),
        .init("CervicalMucusQuality"),
        .init("Contraceptive"),
        .init("InfrequentMenstrualCycles"),
        .init("IntermenstrualBleeding"),
        .init("IrregularMenstrualCycles"),
        .init("Lactation"),
        .init("MenopausalState", minOS: (27, 0)),
        .init("MenstrualFlow"),
        .init("OvulationTestResult"),
        .init("PersistentIntermenstrualBleeding"),
        .init("Pregnancy"),
        .init("PregnancyTestResult"),
        .init("ProgesteroneTestResult"),
        .init("ProlongedMenstrualPeriods"),
        .init("SexualActivity"),
        .init("SleepApneaEvent"),
        .init("SleepAnalysis"),
        .init("AbdominalCramps"),
        .init("Acne"),
        .init("AppetiteChanges"),
        .init("BladderIncontinence"),
        .init("Bloating"),
        .init("BreastPain"),
        .init("ChestTightnessOrPain"),
        .init("Chills"),
        .init("Constipation"),
        .init("Coughing"),
        .init("Diarrhea"),
        .init("Dizziness"),
        .init("DrySkin"),
        .init("Fainting"),
        .init("Fatigue"),
        .init("Fever"),
        .init("GeneralizedBodyAche"),
        .init("HairLoss"),
        .init("Headache"),
        .init("Heartburn"),
        .init("HotFlashes"),
        .init("LossOfSmell"),
        .init("LossOfTaste"),
        .init("LowerBackPain"),
        .init("MemoryLapse"),
        .init("MoodChanges"),
        .init("Nausea"),
        .init("NightSweats"),
        .init("PelvicPain"),
        .init("RapidPoundingOrFlutteringHeartbeat"),
        .init("RunnyNose"),
        .init("ShortnessOfBreath"),
        .init("SinusCongestion"),
        .init("SkippedHeartbeat"),
        .init("SleepChanges"),
        .init("SoreThroat"),
        .init("VaginalDryness"),
        .init("Vomiting"),
        .init("Wheezing"),
    ]

    /// The full catalog in sync order: `priority` first, then header order.
    static let catalog: [Entry] = {
        func version(_ v: (Int, Int)?) -> OperatingSystemVersion? {
            v.map { OperatingSystemVersion(majorVersion: $0.0, minorVersion: $0.1, patchVersion: 0) }
        }
        var all: [Entry] = []
        all += quantityRows.map {
            Entry(kind: .quantity, identifier: "HKQuantityTypeIdentifier" + $0.name, minOS: version($0.minOS))
        }
        all += categoryRows.map {
            Entry(kind: .category, identifier: "HKCategoryTypeIdentifier" + $0.name, minOS: version($0.minOS))
        }
        all.append(Entry(kind: .workout, identifier: workoutIdentifier, minOS: nil))
        let rank = Dictionary(uniqueKeysWithValues: priority.enumerated().map { ($1, $0) })
        let first = all.filter { rank[$0.identifier] != nil }
            .sorted { rank[$0.identifier]! < rank[$1.identifier]! }
        return first + all.filter { rank[$0.identifier] == nil }
    }()

    /// Catalog entries this OS can resolve to a real HealthKit type.
    static var available: [Entry] {
        let refused = disallowed
        return catalog.filter { $0.sampleType != nil && !refused.contains($0.identifier) }
    }

    /// Identifiers HealthKit refused to authorize for reading on this OS
    /// (it raises an exception naming them). Persisted so the read set and
    /// the sync loop skip them from then on.
    static var disallowed: Set<String> {
        get { Set(GatewayConfig.suite.stringArray(forKey: "healthDisallowedTypes") ?? []) }
        set { GatewayConfig.suite.set(Array(newValue).sorted(), forKey: "healthDisallowedTypes") }
    }

    static func entry(for identifier: String) -> Entry? {
        catalog.first { $0.identifier == identifier }
    }

    static let characteristicTypes: [HKCharacteristicType] = [
        HKCharacteristicType(.dateOfBirth),
        HKCharacteristicType(.biologicalSex),
        HKCharacteristicType(.bloodType),
        HKCharacteristicType(.fitzpatrickSkinType),
        HKCharacteristicType(.wheelchairUse),
    ]

    /// The read set handed to `requestAuthorization`. Read only: the app
    /// never writes to Health, so the share set is always empty.
    static var readSet: Set<HKObjectType> {
        var set = Set<HKObjectType>(available.compactMap { $0.sampleType })
        set.formUnion(characteristicTypes)
        return set
    }

    // MARK: - Units

    /// Units fixed by the contract, so the server never converts. A display
    /// label is only overridden where `HKUnit.unitString` disagrees with the
    /// contract's spelling (VO2 max reads "mL/min·kg" from HealthKit).
    struct UnitChoice {
        let unit: HKUnit
        let label: String
    }

    private static let countPerMinute = HKUnit.count().unitDivided(by: .minute())

    static func contractUnit(for identifier: String) -> UnitChoice? {
        func plain(_ unit: HKUnit) -> UnitChoice { UnitChoice(unit: unit, label: unit.unitString) }
        let suffix = identifier.replacingOccurrences(of: "HKQuantityTypeIdentifier", with: "")
        switch suffix {
        case "ActiveEnergyBurned", "BasalEnergyBurned", "DietaryEnergyConsumed":
            return plain(.kilocalorie())
        case "HeartRate", "RestingHeartRate", "WalkingHeartRateAverage", "HeartRateRecoveryOneMinute":
            return plain(countPerMinute)
        case "HeartRateVariabilitySDNN", "HeartRateVariabilityRMSSD":
            return plain(.secondUnit(with: .milli))
        case "BodyMass", "LeanBodyMass":
            return plain(.pound())
        case "BodyFatPercentage", "AtrialFibrillationBurden", "PeripheralPerfusionIndex",
             "AppleWalkingSteadiness", "WalkingAsymmetryPercentage", "WalkingDoubleSupportPercentage",
             "BloodAlcoholContent", "OxygenSaturation":
            // HKUnit.percent() is a fraction: 0.18 means 18%.
            return plain(.percent())
        case "VO2Max":
            let unit = HKUnit.literUnit(with: .milli)
                .unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute()))
            return UnitChoice(unit: unit, label: "ml/kg*min")
        case "AppleExerciseTime", "AppleMoveTime", "AppleStandTime", "TimeInDaylight":
            return plain(.minute())
        default:
            if suffix.hasPrefix("Distance") { return plain(.mile()) }
            return nil
        }
    }

    /// Fallbacks for when `preferredUnits(for:)` fails or omits a type: the
    /// first one compatible with the type wins; none compatible means the
    /// type is skipped.
    static let fallbackUnits: [HKUnit] = [
        .count(),
        countPerMinute,
        .percent(),
        .secondUnit(with: .milli),
        .minute(),
        .second(),
        .meter(),
        .meterUnit(with: .centi),
        .meter().unitDivided(by: .second()),
        .kilocalorie(),
        .kilocalorie().unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .hour())),
        .gram(),
        .literUnit(with: .milli),
        .liter(),
        .liter().unitDivided(by: .minute()),
        .degreeCelsius(),
        .watt(),
        .siemen(),
        .millimeterOfMercury(),
        .internationalUnit(),
        HKUnit.gramUnit(with: .milli).unitDivided(by: .literUnit(with: .deci)),
        .decibelAWeightedSoundPressureLevel(),
        .appleEffortScore(),
    ]

    // MARK: - Labels

    static func categoryLabel(identifier: String, value: Int) -> String? {
        let suffix = identifier.replacingOccurrences(of: "HKCategoryTypeIdentifier", with: "")
        switch suffix {
        case "SleepAnalysis":
            return [0: "inBed", 1: "asleepUnspecified", 2: "awake",
                    3: "asleepCore", 4: "asleepDeep", 5: "asleepREM"][value]
        case "AppleStandHour":
            return [0: "stood", 1: "idle"][value]
        case "MoodChanges", "SleepChanges":
            return [0: "present", 1: "notPresent"][value]
        case "AppetiteChanges":
            return [0: "unspecified", 1: "noChange", 2: "decreased", 3: "increased"][value]
        case "MenstrualFlow", "IntermenstrualBleeding", "BleedingAfterPregnancy",
             "BleedingDuringPregnancy", "BleedingAfterMenopause":
            return [1: "unspecified", 2: "light", 3: "medium", 4: "heavy", 5: "none"][value]
        default:
            if severityTypes.contains(suffix) {
                return [0: "unspecified", 1: "notPresent", 2: "mild", 3: "moderate", 4: "severe"][value]
            }
            return nil
        }
    }

    private static let severityTypes: Set<String> = [
        "AbdominalCramps", "Acne", "BladderIncontinence", "Bloating", "BreastPain",
        "ChestTightnessOrPain", "Chills", "Constipation", "Coughing", "Diarrhea", "Dizziness",
        "DrySkin", "Fainting", "Fatigue", "Fever", "GeneralizedBodyAche", "HairLoss", "Headache",
        "Heartburn", "HotFlashes", "LossOfSmell", "LossOfTaste", "LowerBackPain", "MemoryLapse",
        "Nausea", "NightSweats", "PelvicPain", "RapidPoundingOrFlutteringHeartbeat", "RunnyNose",
        "ShortnessOfBreath", "SinusCongestion", "SkippedHeartbeat", "SoreThroat", "VaginalDryness",
        "Vomiting", "Wheezing",
    ]

    /// Raw `HKWorkoutActivityType` values to readable names (the enum case
    /// names). Keyed by raw value so the deprecated cases need no reference
    /// to their deprecated symbols.
    private static let activityNames: [UInt: String] = [
        1: "americanFootball",
        2: "archery",
        3: "australianFootball",
        4: "badminton",
        5: "baseball",
        6: "basketball",
        7: "bowling",
        8: "boxing",
        9: "climbing",
        10: "cricket",
        11: "crossTraining",
        12: "curling",
        13: "cycling",
        14: "dance",
        15: "danceInspiredTraining",
        16: "elliptical",
        17: "equestrianSports",
        18: "fencing",
        19: "fishing",
        20: "functionalStrengthTraining",
        21: "golf",
        22: "gymnastics",
        23: "handball",
        24: "hiking",
        25: "hockey",
        26: "hunting",
        27: "lacrosse",
        28: "martialArts",
        29: "mindAndBody",
        30: "mixedMetabolicCardioTraining",
        31: "paddleSports",
        32: "play",
        33: "preparationAndRecovery",
        34: "racquetball",
        35: "rowing",
        36: "rugby",
        37: "running",
        38: "sailing",
        39: "skatingSports",
        40: "snowSports",
        41: "soccer",
        42: "softball",
        43: "squash",
        44: "stairClimbing",
        45: "surfingSports",
        46: "swimming",
        47: "tableTennis",
        48: "tennis",
        49: "trackAndField",
        50: "traditionalStrengthTraining",
        51: "volleyball",
        52: "walking",
        53: "waterFitness",
        54: "waterPolo",
        55: "waterSports",
        56: "wrestling",
        57: "yoga",
        58: "barre",
        59: "coreTraining",
        60: "crossCountrySkiing",
        61: "downhillSkiing",
        62: "flexibility",
        63: "highIntensityIntervalTraining",
        64: "jumpRope",
        65: "kickboxing",
        66: "pilates",
        67: "snowboarding",
        68: "stairs",
        69: "stepTraining",
        70: "wheelchairWalkPace",
        71: "wheelchairRunPace",
        72: "taiChi",
        73: "mixedCardio",
        74: "handCycling",
        75: "discSports",
        76: "fitnessGaming",
        77: "cardioDance",
        78: "socialDance",
        79: "pickleball",
        80: "cooldown",
        82: "swimBikeRun",
        83: "transition",
        84: "underwaterDiving",
        3000: "other",
    ]

    static func activityName(_ type: HKWorkoutActivityType) -> String {
        activityNames[type.rawValue] ?? "activity_\(type.rawValue)"
    }

    /// Distance types a workout may carry, most common first.
    static let workoutDistanceIdentifiers: [String] = [
        "HKQuantityTypeIdentifierDistanceWalkingRunning",
        "HKQuantityTypeIdentifierDistanceCycling",
        "HKQuantityTypeIdentifierDistanceSwimming",
        "HKQuantityTypeIdentifierDistanceRowing",
        "HKQuantityTypeIdentifierDistancePaddleSports",
        "HKQuantityTypeIdentifierDistanceCrossCountrySkiing",
        "HKQuantityTypeIdentifierDistanceSkatingSports",
        "HKQuantityTypeIdentifierDistanceDownhillSnowSports",
        "HKQuantityTypeIdentifierDistanceWheelchair",
    ]
}
