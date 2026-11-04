import Foundation

/// A preview's private defaults suite, or a preview that stops rather than
/// reading and writing the app's real defaults.
enum PreviewDefaults {
    static func suite(_ name: String) -> UserDefaults {
        guard let defaults = UserDefaults(suiteName: name) else {
            preconditionFailure("Preview defaults suite '\(name)' could not be created")
        }
        defaults.removePersistentDomain(forName: name)
        return defaults
    }
}
