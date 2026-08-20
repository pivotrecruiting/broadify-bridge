import AppKit
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

            if manager.needsMoveToApplications {
                VStack(alignment: .leading, spacing: 8) {
                    Text(
                        "macOS blocked the camera extension because BroadifyVCam is not "
                            + "running from the Applications folder (App Translocation). "
                            + "Move BroadifyVCam.app to /Applications using Finder, then "
                            + "launch it from there and try again."
                    )
                    .font(.footnote)
                    .foregroundStyle(.orange)

                    Button("Show in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
                    }
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
        .onAppear {
            manager.refreshLaunchState()
            manager.activateFromLaunchArgumentIfRequested()
        }
    }
}

/**
 * Wraps OSSystemExtensionManager requests for the camera extension.
 */
final class ExtensionManager: NSObject, ObservableObject, OSSystemExtensionRequestDelegate {
    @Published var statusText = "Ready."
    @Published var isRequestingActivation = false
    @Published var awaitingUserApproval = false
    @Published var needsMoveToApplications = false

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

    /// Computes the launch banner state; called from onAppear. Deliberately no
    /// automatic activation request here — that would loop the approval prompt
    /// on every launch.
    func refreshLaunchState() {
        needsMoveToApplications = BundleLocation.needsMoveToApplications
        if needsMoveToApplications {
            logger.warning(
                "App runs outside /Applications (translocated=\(BundleLocation.isTranslocated)) appBundle=\(Bundle.main.bundlePath, privacy: .public)"
            )
        }
    }

    private var launchArgumentHandled = false

    /// Bridge-driven activation: when launched with --activate (the bridge
    /// passes it on every virtual-camera start attempt), submit the
    /// activation request without requiring a click in this window. Guarded
    /// to once per process so normal manual launches never loop the
    /// approval prompt (see refreshLaunchState comment).
    func activateFromLaunchArgumentIfRequested() {
        guard !launchArgumentHandled else { return }
        launchArgumentHandled = true
        guard CommandLine.arguments.contains("--activate") else { return }
        logger.info("Activation requested via --activate launch argument")
        activate()
    }

    func activate() {
        // Guard before submitting: with the app translocated or outside
        // /Applications the request is guaranteed to fail with
        // OSSystemExtensionError code 3, so guide the user instead.
        refreshLaunchState()
        if needsMoveToApplications {
            statusText =
                "Cannot activate from \(Bundle.main.bundlePath). "
                + "Move BroadifyVCam.app to /Applications and launch it from there."
            return
        }

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

        // Defense-in-depth for the pre-submit guard in activate(): macOS
        // rejects activation from outside /Applications (App Translocation).
        if let nsError = error as NSError?,
           nsError.domain == OSSystemExtensionErrorDomain,
           nsError.code == OSSystemExtensionError.unsupportedParentBundleLocation.rawValue {
            needsMoveToApplications = true
            statusText =
                "macOS blocked the camera extension because BroadifyVCam is not running "
                + "from the Applications folder (App Translocation). "
                + "Move BroadifyVCam.app to /Applications using Finder, then launch it "
                + "from there and try again. Current location: \(Bundle.main.bundlePath)."
            logger.error(
                "Extension request failed with unsupportedParentBundleLocation appBundle=\(Bundle.main.bundlePath, privacy: .public)"
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
