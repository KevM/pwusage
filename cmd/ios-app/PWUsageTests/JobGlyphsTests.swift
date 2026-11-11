import Foundation
@testable import PWUsage
import Testing
import UIKit

@Suite("Job glyphs")
struct JobGlyphsTests {
    private func job(id: String = "x", kind: LoadProfileKind, symbol: String? = nil) -> LoadProfile {
        LoadProfile(id: id, name: "Job", kind: kind, energyKwh: 2, durationHours: 1, carSettings: nil, symbol: symbol)
    }

    @Test("The gallery has no repeats and every symbol exists on this system")
    func galleryIsCleanAndReal() {
        #expect(Set(JobGlyphs.gallery).count == JobGlyphs.gallery.count)
        #expect(JobGlyphs.gallery.count >= 24)
        for name in JobGlyphs.gallery {
            #expect(UIImage(systemName: name) != nil, "\(name)")
        }
    }

    @Test("A chosen symbol wins")
    func chosenSymbolWins() {
        #expect(JobGlyphs.symbol(for: job(kind: .custom, symbol: "flame.fill")) == "flame.fill")
    }

    @Test("A blank symbol falls back to the kind")
    func blankSymbolFallsBack() {
        #expect(JobGlyphs.symbol(for: job(kind: .car, symbol: "  ")) == "car.fill")
        #expect(JobGlyphs.symbol(for: job(kind: .appliance)) == "powerplug.fill")
        #expect(JobGlyphs.symbol(for: job(kind: .custom)) == "slider.horizontal.3")
    }

    @Test("The starter jobs keep their own glyphs without a saved one")
    func starterJobsKeepTheirGlyphs() {
        #expect(JobGlyphs.symbol(for: job(id: "dishwasher", kind: .appliance)) == "dishwasher.fill")
        #expect(JobGlyphs.symbol(for: job(id: "washer", kind: .appliance)) == "washer.fill")
        #expect(JobGlyphs.symbol(for: job(id: "dryer", kind: .appliance)) == "dryer.fill")
        #expect(JobGlyphs.symbol(for: job(id: "washer-dryer-combo", kind: .appliance)) == "washer.fill")
        #expect(JobGlyphs.symbol(for: job(id: "car", kind: .car)) == "car.fill")
    }

    @Test("Every template starts with a gallery symbol")
    func templatesStartWithGallerySymbols() {
        for template in JobTemplates.all {
            let symbol = template.draft.symbol
            #expect(symbol != nil && JobGlyphs.gallery.contains(symbol ?? ""), "\(template.id)")
        }
    }

    @Test("A draft carries and compares its symbol")
    func draftCarriesSymbol() {
        let tub = LoadProfile(id: "tub", name: "Hot tub", kind: .custom, energyKwh: 20, durationHours: 4,
                              carSettings: nil, symbol: "bathtub.fill")
        let original = ProfileDraft(profile: tub)
        #expect(original.symbol == "bathtub.fill")
        var changed = original
        changed.symbol = "flame.fill"
        #expect(changed.hasUnsavedChanges(from: original))
    }
}
