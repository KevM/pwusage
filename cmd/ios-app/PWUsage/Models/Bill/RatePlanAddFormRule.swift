/// Whether Bill's Add Rate Plan opens the add form. It waits for the timeline, so the form has the
/// site's timezone, currency and plan names, and it opens once per presentation.
enum RatePlanAddFormRule {
    static func shouldOpen(startsAddingPlan: Bool, timelineLoaded: Bool, alreadyOpened: Bool) -> Bool {
        startsAddingPlan && timelineLoaded && !alreadyOpened
    }
}
