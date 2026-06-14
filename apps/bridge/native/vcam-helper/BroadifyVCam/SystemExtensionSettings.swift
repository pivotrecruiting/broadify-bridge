import AppKit
import ServiceManagement

/**
 * Opens the macOS pane where users approve camera system extensions.
 * Apple does not allow granting this permission inside the app itself.
 */
enum SystemExtensionSettings {
    private static let loginItemsURL =
        "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"

    static func openCameraExtensionApprovalPane() {
        if #available(macOS 13.0, *) {
            SMAppService.openSystemSettingsLoginItems()
            return
        }

        guard let url = URL(string: loginItemsURL) else {
            return
        }
        NSWorkspace.shared.open(url)
    }
}
