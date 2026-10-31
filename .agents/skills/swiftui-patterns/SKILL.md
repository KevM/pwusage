---
name: swiftui-patterns
description: >-
  Guidelines for writing clean SwiftUI views and components in pwusage's iOS app.
  Covers view decomposition to satisfy SwiftLint's 50-line function body budget,
  reusable UI primitives in Views/Shared/, coordinator state binding, and #Preview conventions.
---

# SwiftUI Patterns & Guidelines for `pwusage`

This skill provides patterns for building SwiftUI views that conform to the project's architecture, design language, and SwiftLint limits in `cmd/ios-app`.

---

## 1. Respecting the 50-Line Function Body Budget

SwiftLint strictly limits function and computed property bodies to **50 lines** (warning) and **100 lines** (error). A monolithic `var body: some View` is the most common cause of lint failures.

### Recommended Pattern: View Decomposition

Decompose complex layouts into focused private `@ViewBuilder` properties or dedicated subviews:

```swift
struct LivePowerView: View {
    @ObservedObject var coordinator: DashboardCoordinator

    var body: some View {
        VStack(spacing: 16) {
            headerSection
            metricsGrid
            statusFooter
        }
        .padding()
    }

    @ViewBuilder
    private var headerSection: some View {
        HStack {
            Text("Power Flow")
                .font(.headline)
            Spacer()
            DischargeSymbol(isDischarging: coordinator.power.data?.isDischarging ?? false)
        }
    }

    @ViewBuilder
    private var metricsGrid: some View {
        if let data = coordinator.power.data {
            LivePowerFlowCards(power: data)
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private var statusFooter: some View {
        Text("Updated \(coordinator.power.data?.formattedTimestamp ?? "--")")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}
```

---

## 2. Reusable Primitives in `Views/Shared/`

Before inventing custom styles, cards, or banners, leverage the existing primitives in `cmd/ios-app/PWUsage/Views/Shared/`:

- **`CardContainer`** (`card-container.swift`): Wrap content in standardized card surfaces:
  ```swift
  CardContainer {
      VStack(alignment: .leading) { ... }
  }
  ```
- **`SectionTheme`** (`section-theme.swift`): Use standard section header styles, badges, and tint colors.
- **`EmptyStateScreen`** (`empty-state-screen.swift`): Use for empty states, missing permissions, or configuration prompts.
- **`clipboard`** (`clipboard.swift`): Standard copy-to-clipboard interactions.
- **`portable-modifiers`** (`portable-modifiers.swift`): Adaptive padding and safe-area adjustments.

---

## 3. Sheet Presentation Management

The app uses mutually exclusive sheet presentation driven by enums in coordinators (e.g. `presentedSheet`):

```swift
.sheet(item: $coordinator.presentedSheet) { sheet in
    switch sheet {
    case .batteryHold:
        BatteryHoldSheet(coordinator: coordinator)
    case .tariffs:
        TariffSheet(coordinator: coordinator)
    case .settings:
        SettingsView(coordinator: coordinator)
    }
}
```
*Never layer multiple independent `.sheet(isPresented: $bool)` modifiers on the same container if they can trigger concurrently.*

---

## 4. Modern `#Preview` Conventions

- Use Swift’s modern `#Preview` macro syntax instead of deprecated `PreviewProvider` structs.
- Use `PreviewFixture` or mock state instances so previews render accurately without network calls:

```swift
#Preview("Loaded State") {
    let coordinator = DashboardCoordinator(previewFixture: .sunnyDay)
    LivePowerView(coordinator: coordinator)
}
```
