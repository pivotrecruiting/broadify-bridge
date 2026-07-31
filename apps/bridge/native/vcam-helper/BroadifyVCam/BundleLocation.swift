import Foundation

/**
 * Detects the App-Translocation trap: macOS only activates system extensions
 * from an app that really runs under /Applications. A quarantined bundle
 * launched via double-click runs from a random read-only mount under
 * /private/var/.../AppTranslocation/ instead, and the activation request then
 * fails with OSSystemExtensionError code 3 (unsupportedParentBundleLocation).
 *
 * The path heuristic is used on purpose: SecTranslocateIsTranslocatedURL is
 * private SPI, while the prefix checks also catch launches straight from a
 * mounted DMG or the Downloads folder.
 */
enum BundleLocation {
    static var isTranslocated: Bool {
        Bundle.main.bundlePath.contains("/AppTranslocation/")
    }

    static var isInApplicationsFolder: Bool {
        Bundle.main.bundlePath.hasPrefix("/Applications/")
    }

    /// True when an activation request would be rejected by macOS because of
    /// where the app is running from. A sandboxed, translocated app cannot
    /// move itself (the mount is read-only), so the UI must guide the user.
    static var needsMoveToApplications: Bool {
        isTranslocated || !isInApplicationsFolder
    }
}
