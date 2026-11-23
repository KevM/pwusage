enum RatePlanResponseFixture {
    private static let snapshotFields = """
    "utilityName": null, "choiceKind": "automatic", "urdbLabel": null, "revisionStart": null,
    "contentHash": "c", "holidaysUseWeekendSchedule": true, "seasons": [], "approximationNotes": [],
    "verification": null
    """

    static let previewJSON = """
    {
      "reviewHash": "hash-1", "siteId": "site-1", "scope": "actual",
      "effectiveFrom": "2025-03-01", "effectiveTo": null, "currency": "USD", "unit": "kWh",
      "timezone": "America/Chicago", "holidaysUseWeekendSchedule": true, "recalculatesHistory": true,
      "recalculatesFromHistoryStart": false,
      "recalculationRange": { "fromDate": "2025-03-01", "toDate": null }, "affectsPowerwallPlan": false,
      "candidatePlan": null,
      "affectedIntervals": [{
        "effectiveFrom": "2025-03-01", "effectiveTo": null, "kind": "replace", "beforeIsFallback": false,
        "before": { "tariffId": 17, "version": 1, "periodId": 7, "selectionId": null, "name": "Tesla",
                    "source": "tesla", "exportRateProvenance": "tesla", \(snapshotFields) },
        "after": { "tariffId": null, "version": null, "periodId": null, "selectionId": null, "name": "Public",
                   "source": "estimated", "exportRateProvenance": "net_metering", \(snapshotFields) },
        "seasons": [], "hasBuyRateChanges": true, "hasSellRateChanges": false, "hasRateChanges": true,
        "hasPeriodNameChanges": false,
        "restoration": { "status": "preserves_tesla_original", "original": {
          "originalSelectionId": 3, "tariffId": 17, "name": "Tesla", "version": 1, "contentHash": "c",
          "effectiveFrom": "2025-01-01", "effectiveTo": null } }
      }],
      "unchangedOutsidePeriods": [],
      "restoration": { "preservedOriginals": [], "restoredOriginals": [], "unavailableRanges": [],
                       "canApplyRestoration": true },
      "approximationNotes": [{ "kind": "tier_blended", "message": "Tiers blended" },
                             { "kind": "day_specific_schedule", "message": "Days" },
                             { "kind": "something_new", "message": "New" }],
      "summary": { "hasBuyRateChanges": true, "hasSellRateChanges": false, "hasRateChanges": true,
                   "hasPeriodNameChanges": false, "fillsGap": false, "replacesExistingPlan": true }
    }
    """

    static let batchPreviewJSON = """
    {
      "reviewHash": "batch-hash-1",
      "siteId": "site-1",
      "currency": "USD",
      "unit": "kWh",
      "timezone": "America/Chicago",
      "notes": ["Added rider"],
      "sources": ["https://austinenergy.com/rates"],
      "unchangedActualCount": 0,
      "unchangedReferenceCount": 1,
      "actualPreviews": [\(previewJSON)],
      "referencePreviews": [],
      "recalculatesHistory": true,
      "recalculatesFromHistoryStart": false,
      "recalculationRange": { "fromDate": "2025-03-01", "toDate": null },
      "affectsPowerwallPlan": false
    }
    """
}
