import SwiftUI

/**
 * Minimal container app for the broadify virtual camera extension.
 *
 * macOS requires camera extensions to ship inside a signed host app.
 * This stub only activates/deactivates the bundled system extension;
 * frame delivery happens entirely through the FrameBus shared memory.
 */
@main
struct BroadifyVCamApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 420, minHeight: 260)
        }
    }
}
