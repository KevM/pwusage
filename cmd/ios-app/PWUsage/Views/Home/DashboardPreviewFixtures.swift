#if DEBUG
    import Foundation

    @MainActor
    final class DashboardPreviewAPI: MobileDashboardDataAPI, MobileSolarHistoryDataAPI {
        let mode: DashboardPreviewMode
        // Held as JSON and decoded on demand rather than decoded once in `init`.
        // This file is an app-target `#if DEBUG` file that the test target also
        // compiles, so a fixture that cannot decode used to be a `try!` in an
        // initializer: a `DecodingError` became `_assertionFailure` -> `SIGTRAP` and
        // took the whole test binary down, which is the exact mechanism §5.12 removed
        // from the test fixtures and which survived here because the greps that check
        // for it only looked in `PWUsageTests/`. Decoding inside the two `fetch`
        // methods, which already throw, puts the failure on the one call that needed
        // the value and hands the caller the error that explains it.
        private let liveJSON: String
        private let billJSON: String

        init(
            mode: DashboardPreviewMode, site: MobileSite = .preview, asOf: Date = .now,
            liveJSON: String? = nil, billJSON: String? = nil
        ) {
            self.mode = mode
            let fixture = DashboardPreviewFixture(mode: mode, site: site, asOf: asOf)
            self.liveJSON = liveJSON ?? fixture.liveJSON
            self.billJSON = billJSON ?? fixture.billJSON
        }

        func fetchLive(siteID: String) async throws -> MobileLiveResponse {
            if mode == .error { throw URLError(.notConnectedToInternet) }
            return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(liveJSON.utf8))
        }

        func fetchBill(siteID: String) async throws -> MobileBillResponse {
            if mode == .error { throw PWUsageAPIError.recoverableServerError(statusCode: 503) }
            return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(billJSON.utf8))
        }

        func fetchSolarHistory(
            siteID: String, from: String, changedSince: Date?
        ) async throws -> MobileSolarHistoryResponse {
            .enabled(timeZone: .gmt, days: [], nextFrom: nil)
        }
    }

    /// Builds the JSON each preview mode shows, so the API's initializer stays a
    /// thin seam over the payloads and the mode switches live in one place.
    private struct DashboardPreviewFixture {
        let mode: DashboardPreviewMode
        let site: MobileSite
        let asOf: Date

        var liveJSON: String {
            // `stateOfChargeAt` shares the live reading's source instant on purpose: decoding treats an
            // undated charge as unknown (§5.4), so a fixture that omits the key would render `--` for
            // the wrong reason. Every mode reports a charge of 72. The stale mode deliberately reports
            // one anyway, against a source two hours and a minute old, so the `--` it shows is caused
            // by the client-side freshness rule rather than by the fixture withholding the value.
            #"{"version":1,"site":{"id":"\#(site.id)","name":"\#(site.name)","#
                + #""timezone":"America/Chicago","localDate":"2026-09-23"},"live":{"solarPower":4180,"#
                + #""loadPower":1260,"batteryPower":-2920,"gridPower":0},"stateOfCharge":72,"activeTariff":"#
                + #"\#(tariffJSON),"activeLoadTiming":\#(activeLoadTimingJSON),"today":{"homeKwh":18.4,"#
                + #""solarKwh":14.8,"#
                + #""gridNetKwh":3.6,"batteryNetKwh":-2.1},"todayComplete":true,"currentBill":null,"#
                + #""sources":{"liveStatusAt":"\#(sourceTime)","energyDataThrough":"#
                + #"\#(hasData ? #""\#(sourceTime)""# : "null"),"stateOfChargeAt":"\#(sourceTime)"}}"#
        }

        var billJSON: String {
            #"{"version":1,"site":{"id":"\#(site.id)","name":"\#(site.name)","#
                + #""timezone":"America/Chicago"},"currentBill":{"estimatedCost":146.82,"currency":"USD","#
                + #""cycleStart":"\#(cycleStartText)","cycleEnd":"\#(cycleEndText)","#
                + #""periods":[{"tariffName":"Residential · Time of use","periodName":"Off peak","netGridKwh":214.6,"#
                + #""cost":26.83},{"tariffName":"Residential · Time of use","periodName":"Peak","netGridKwh":142.8,"#
                + #""cost":87.75},{"tariffName":"Residential · Time of use","periodName":"Solar credit","#
                + #""netGridKwh":-94.2,"cost":-8.72}]},"loadTiming":\#(hasTariff ? loadTimingJSON : "null"),"#
                + #""sources":{"calculatedAt":"\#(calculatedTime)","energyDataThrough":"\#(sourceTime)"}}"#
        }

        private var hasData: Bool { mode != .empty }
        private var hasTariff: Bool { mode != .noTariff }

        /// Round down once so serialization cannot move a charge reading into
        /// the future. Keep all forecast/balance timestamps on that same instant.
        private var previewNow: Date { Date(timeIntervalSince1970: floor(asOf.timeIntervalSince1970)) }

        /// The stale mode is 2h01m old rather than exactly 2h: a charge reading is suppressed only
        /// once it is *older* than two hours, and fixture construction and decoding happen at
        /// slightly different instants, so the exact edge would be decided by clock jitter.
        private var balanceSource: Date {
            previewNow.addingTimeInterval(mode == .stale ? -(2 * 60 * 60 + 60) : 0)
        }

        private var sourceTime: String { instantString(balanceSource) }
        private var calculatedTime: String { instantString(previewNow) }

        private var cycleStart: Date {
            Calendar.current.dateInterval(of: .month, for: previewNow)?.start
                ?? previewNow.addingTimeInterval(-14 * 86400)
        }

        private var cycleEnd: Date {
            Calendar.current.date(byAdding: .month, value: 1, to: cycleStart)
                ?? previewNow.addingTimeInterval(14 * 86400)
        }

        private var cycleStartText: String { ISO8601DateFormatter().string(from: cycleStart) }
        private var cycleEndText: String { ISO8601DateFormatter().string(from: cycleEnd) }

        /// Production serializes both the energy observation time and the tariff
        /// timeline with fractional seconds, and starts the timeline at the
        /// observation time. Match that exactly: if the timeline begins even a
        /// fraction of a second later, the estimator's shared horizon collapses to
        /// the source instant and the forecast silently never becomes available.
        private func instantString(_ date: Date) -> String {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.string(from: date)
        }

        private var peakBalance: Double {
            switch mode {
            case .modestSurplus: 2.5
            // Peak is a net buyer and Off peak a net seller. That gives the tiles a
            // real 48c-vs-12c difference instead of two identical sell rates, and it
            // leaves the basic layer with no suggestion — the case where the solar
            // forecast belongs on the explorer card rather than the recommendation.
            case .normal: -4.2
            case .abundantSurplus: 120
            case .stale: 20
            case .noFit: -12
            case .unknownBalance: -4.2
            default: -4.2
            }
        }

        private var offPeakBalance: Double {
            switch mode {
            case .modestSurplus: 1.5
            case .abundantSurplus: 120
            case .noFit: -12
            case .unknownBalance: 32.4
            default: 32.4
            }
        }

        private var tariffTimelineJSON: String {
            (0 ..< 28).map { index in
                let interval: TimeInterval = mode == .tariffCrossing ? 60 * 60 : 6 * 60 * 60
                // Start the timeline at the balance source instant, as production does.
                let start = balanceSource.addingTimeInterval(TimeInterval(index) * interval)
                let end = previewNow.addingTimeInterval(TimeInterval(index + 1) * interval)
                let name = mode == .tariffCrossing
                    ? (index.isMultiple(of: 2) ? "Peak" : "Off peak")
                    : (index.isMultiple(of: 4) ? "Peak" : "Off peak")
                let buyRate = name == "Peak" ? 0.48 : 0.22
                let sellRate = 0.12
                return #"{"start":"\#(instantString(start))","end":""#
                    + #"\#(instantString(end))","periodKey":"\#(name)","name":"\#(name)","buyRate":"#
                    + #"\#(buyRate),"sellRate":\#(sellRate)}"#
            }.joined(separator: ",")
        }

        private var activeLoadTimingJSON: String {
            if !hasTariff { return "null" }
            if !hasData {
                return #"{"periodName":"Peak","buyRate":0.48,"sellRate":0.12,"marginalCost":null,"basis":"unobserved","#
                    + #""balanceKwh":null,"energyDataThrough":null}"#
            }
            return #"{"periodName":"Peak","buyRate":0.48,"sellRate":0.12,"marginalCost":"#
                + #"\#(peakBalance > 0 ? "0.12" : "0.48"),"basis":\#(peakBalance > 0 ? #""sell""# : #""buy""#),"#
                + #""balanceKwh":\#(peakBalance),"energyDataThrough":"\#(sourceTime)"}"#
        }

        private var tariffJSON: String {
            hasTariff ? #""Residential · Time of use""# : #""Unknown""#
        }

        private var observedPeriodsJSON: String {
            if !hasData {
                return "[]"
            }
            if mode == .unknownBalance {
                return #"[{"name":"Off peak","marginalCost":0.12,"basis":"sell","cycleNetExportKwh":"#
                    + #"\#(offPeakBalance),"isActive":false,"nextStartPhrase":"tomorrow at 12:00 AM","buyRate":0.22,"#
                    + #""sellRate":0.12}]"#
            }
            return #"[{"name":"Peak","marginalCost":\#(peakBalance > 0 ? "0.12" : "0.48"),"basis":"#
                + #"\#(peakBalance > 0 ? #""sell""# : #""buy""#),"cycleNetExportKwh":\#(peakBalance),"#
                + #""isActive":true,"nextStartPhrase":"in 3 hours","buyRate":0.48,"sellRate":0.12},"#
                + #"{"name":"Off peak","marginalCost":0.12,"basis":"sell","cycleNetExportKwh":"#
                + #"\#(offPeakBalance),"isActive":false,"nextStartPhrase":"tomorrow at 12:00 AM","buyRate":0.22,"#
                + #""sellRate":0.12}]"#
        }

        private var loadTimingJSON: String {
            #"{"hasTariff":true,"hasCycleData":\#(hasData ? "true" : "false"),"#
                + #""activeIsCheapest":false,"periods":\#(observedPeriodsJSON),"pricingPeriods":[{"name":"Off peak","#
                + #""marginalCost":\#(hasData ? "0.12" : "null"),"basis":"#
                + #"\#(hasData ? #""sell""# : #""unobserved""#),"cycleNetExportKwh":"#
                + #"\#(hasData ? String(offPeakBalance) : "0"),"isActive":false,"#
                + #""nextStartPhrase":"tomorrow at 12:00 AM","buyRate":0.22,"sellRate":0.12},{"name":"Peak","#
                + #""marginalCost":\#(hasData ? (peakBalance > 0 ? "0.12" : "0.48") : "null"),"basis":"#
                + #"\#(hasData ? (peakBalance > 0 ? #""sell""# : #""buy""#) : #""unobserved""#),"cycleNetExportKwh":"#
                + #"\#(hasData ? String(peakBalance) : "0"),"isActive":true,"nextStartPhrase":"in 3 hours","#
                + #""buyRate":0.48,"sellRate":0.12},{"name":"Shoulder","marginalCost":null,"basis":"unobserved","#
                + #""cycleNetExportKwh":0,"isActive":false,"nextStartPhrase":"tomorrow at 10:00 PM","buyRate":0.30,"#
                + #""sellRate":0.08}],"tariffTimeline":[\#(tariffTimelineJSON)],"nextCheaper":"#
                + #"\#(hasData ? #"{"name":"Off peak","marginalCost":0.12,"phrase":"in 3 hours"}"# : "null"),"#
                + #""nextCheaperPhrase":\#(hasData ? #""Wait until Off peak in 3 hours""# : "null"),"#
                + #""nextStartPhraseByKey":{"Peak":"in 3 hours","Off peak":"tomorrow at 12:00 AM","#
                + #""Shoulder":"tomorrow at 10:00 PM"}}"#
        }
    }
#endif
