import SwiftUI
import SystemExtensions

/**
 * Single-view UI with activate/deactivate controls for the camera
 * extension plus a small status log.
 */
struct ContentView: View {
    @StateObject private var manager = ExtensionManager()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("broadify Virtual Camera")
                .font(.title2)
                .bold()
            Text(
                "Installs the system camera extension. The meeting engine "
                    + "publishes frames via FrameBus shared memory."
            )
            .font(.callout)
            .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                Button("Activate extension") {
                    manager.activate()
                }
                Button("Deactivate extension") {
                    manager.deactivate()
                }
            }

            Text(manager.statusText)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            Spacer()
        }
        .padding(24)
    }
}

/**
 * Wraps OSSystemExtensionManager requests for the camera extension.
 */
final class ExtensionManager: NSObject, ObservableObject, OSSystemExtensionRequestDelegate {
    @Published var statusText = "Ready."

    private var extensionIdentifier: String {
        // Must match the PRODUCT_BUNDLE_IDENTIFIER of the extension target.
        "com.broadify.vcam.extension"
    }

    func activate() {
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: extensionIdentifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
        statusText = "Activation requested…"
    }

    func deactivate() {
        let request = OSSystemExtensionRequest.deactivationRequest(
            forExtensionWithIdentifier: extensionIdentifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
        statusText = "Deactivation requested…"
    }

    // MARK: - OSSystemExtensionRequestDelegate

    func request(
        _ request: OSSystemExtensionRequest,
        actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension ext: OSSystemExtensionProperties
    ) -> OSSystemExtensionRequest.ReplacementAction {
        .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        statusText = "Waiting for approval in System Settings → Privacy & Security."
    }

    func request(
        _ request: OSSystemExtensionRequest,
        didFinishWithResult result: OSSystemExtensionRequest.Result
    ) {
        switch result {
        case .completed:
            statusText = "Extension request completed."
        case .willCompleteAfterReboot:
            statusText = "Extension will be active after a reboot."
        @unknown default:
            statusText = "Extension request finished with unknown result."
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        statusText = "Extension request failed: \(error.localizedDescription)"
    }
}
