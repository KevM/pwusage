#if DEBUG
    import SwiftUI

    #Preview("Load profiles · built-ins and custom") {
        let defaults = PreviewDefaults.suite("LoadProfilesSheetPreview")
        let store = LoadProfileStore(userDefaults: defaults)
        _ = try? store.createCustomProfile(name: "Workshop heater", energyKwh: 6, durationHours: 2)
        _ = try? store.createCustomProfile(name: "Garden pump", energyKwh: 1.5, durationHours: 0.5)
        return LoadProfilesSheet(store: store)
    }

    #Preview("Load profiles · accessibility size") {
        let defaults = PreviewDefaults.suite("LoadProfilesSheetAccessibilityPreview")
        let store = LoadProfileStore(userDefaults: defaults)
        _ = try? store.createCustomProfile(name: "Workshop heater", energyKwh: 6, durationHours: 2)
        _ = try? store.createCustomProfile(name: "Garden pump", energyKwh: 1.5, durationHours: 0.5)
        return LoadProfilesSheet(store: store)
            .environment(\.dynamicTypeSize, .accessibility3)
    }
#endif
