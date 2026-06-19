import SwiftUI
import SystemExtensions
import Foundation
import os

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

            if manager.awaitingUserApproval {
                VStack(alignment: .leading, spacing: 8) {
                    Text(
                        "macOS requires approval in System Settings. "
                            + "Open General → Login Items & Extensions → Camera Extensions, "
                            + "then enable broadify Virtual Camera."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                    Button("Open System Settings") {
                        SystemExtensionSettings.openCameraExtensionApprovalPane()
                    }
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
    @Published var isRequestingActivation = false
    @Published var awaitingUserApproval = false

    private let logger = Logger(subsystem: "com.broadify.vcam", category: "system-extension")

    private var extensionIdentifier: String {
        // Must match the PRODUCT_BUNDLE_IDENTIFIER of the extension target.
        "com.broadify.vcam.extension"
    }

    private var expectedEmbeddedExtensionPath: String {
        Bundle.main.bundleURL
            .appendingPathComponent("Contents/Library/SystemExtensions/\(extensionIdentifier).systemextension")
            .path
    }

    func activate() {
        isRequestingActivation = true
        awaitingUserApproval = false
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: extensionIdentifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
        let extensionExists = FileManager.default.fileExists(atPath: expectedEmbeddedExtensionPath)
        logger.info(
            "Activation requested appBundle=\(Bundle.main.bundlePath, privacy: .public) embeddedExtension=\(self.expectedEmbeddedExtensionPath, privacy: .public) exists=\(extensionExists)"
        )
        statusText =
            "Activation requested… App bundle: \(Bundle.main.bundlePath). "
            + "Expected embedded extension: \(expectedEmbeddedExtensionPath). "
            + "Exists on disk: \(extensionExists ? "yes" : "no")."
    }

    func deactivate() {
        isRequestingActivation = true
        awaitingUserApproval = false
        let request = OSSystemExtensionRequest.deactivationRequest(
            forExtensionWithIdentifier: extensionIdentifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
        logger.info("Deactivation requested for \(self.extensionIdentifier, privacy: .public)")
        statusText = "Deactivation requested…"
    }

    // MARK: - OSSystemExtensionRequestDelegate

    func request(
        _ request: OSSystemExtensionRequest,
        actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension ext: OSSystemExtensionProperties
    ) -> OSSystemExtensionRequest.ReplacementAction {
        statusText =
            "Replacing extension v\(existing.bundleShortVersion)/\(existing.bundleVersion) "
            + "with v\(ext.bundleShortVersion)/\(ext.bundleVersion)…"
        logger.info(
            "Replacing extension existing=\(existing.bundleShortVersion, privacy: .public)/\(existing.bundleVersion, privacy: .public) new=\(ext.bundleShortVersion, privacy: .public)/\(ext.bundleVersion, privacy: .public)"
        )
        return .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        awaitingUserApproval = true
        statusText =
            "Waiting for approval in System Settings → General → Login Items & Extensions → Camera Extensions."
        logger.info("Activation requires user approval in System Settings")
        SystemExtensionSettings.openCameraExtensionApprovalPane()
    }

    func request(
        _ request: OSSystemExtensionRequest,
        didFinishWithResult result: OSSystemExtensionRequest.Result
    ) {
        isRequestingActivation = false
        awaitingUserApproval = false
        switch result {
        case .completed:
            logger.info("Extension request completed")
            statusText = "Extension request completed."
        case .willCompleteAfterReboot:
            logger.info("Extension request will complete after reboot")
            statusText = "Extension will be active after a reboot."
        @unknown default:
            logger.error("Extension request finished with unknown result")
            statusText = "Extension request finished with unknown result."
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        isRequestingActivation = false
        awaitingUserApproval = false

        if let nsError = error as NSError?,
           nsError.domain == OSSystemExtensionErrorDomain,
           nsError.code == OSSystemExtensionError.extensionNotFound.rawValue {
            let extensionExists = FileManager.default.fileExists(atPath: expectedEmbeddedExtensionPath)
            statusText =
                "Extension request failed: embedded system extension was not found by macOS. "
                + "App bundle: \(Bundle.main.bundlePath). "
                + "Expected embedded extension: \(expectedEmbeddedExtensionPath). "
                + "Exists on disk: \(extensionExists ? "yes" : "no")."
            logger.error(
                "Extension request failed because embedded extension was not found appBundle=\(Bundle.main.bundlePath, privacy: .public) embeddedExtension=\(self.expectedEmbeddedExtensionPath, privacy: .public) exists=\(extensionExists)"
            )
            return
        }

        statusText =
            "Extension request failed: \(error.localizedDescription). "
            + formatNSError(error as NSError)
        logger.error("Extension request failed: \(self.formatNSError(error as NSError), privacy: .public)")
    }

    private func formatNSError(_ error: NSError) -> String {
        var parts: [String] = [
            "domain=\(error.domain)",
            "code=\(error.code)",
        ]

        if !error.userInfo.isEmpty {
            let serialized = error.userInfo.map { key, value in
                "\(key)=\(String(describing: value))"
            }.sorted().joined(separator: ", ")
            parts.append("userInfo={\(serialized)}")
        }

        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            parts.append("underlying=[\(formatNSError(underlying))]")
        }

        return parts.joined(separator: " ")
    }
}
