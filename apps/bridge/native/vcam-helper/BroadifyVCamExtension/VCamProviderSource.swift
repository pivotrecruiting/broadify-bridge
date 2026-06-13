import CoreMediaIO
import Foundation

/**
 * CMIOExtension provider that exposes a single virtual camera device
 * ("broadify Camera") backed by the FrameBus shared-memory session of the
 * meeting engine sidecar.
 */
final class VCamProviderSource: NSObject, CMIOExtensionProviderSource {
    private(set) var provider: CMIOExtensionProvider!
    private var deviceSource: VCamDeviceSource!

    init(clientQueue: DispatchQueue?) {
        super.init()
        provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
        deviceSource = VCamDeviceSource(localizedName: "broadify Camera")
        do {
            try provider.addDevice(deviceSource.device)
        } catch {
            fatalError("Failed to add virtual camera device: \(error.localizedDescription)")
        }
    }

    func connect(to client: CMIOExtensionClient) throws {
        // All clients (Teams, Zoom, Meet, browsers) are accepted.
    }

    func disconnect(from client: CMIOExtensionClient) {
        // Nothing to clean up per client.
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.providerManufacturer, .providerName]
    }

    func providerProperties(
        forProperties properties: Set<CMIOExtensionProperty>
    ) throws -> CMIOExtensionProviderProperties {
        let providerProperties = CMIOExtensionProviderProperties(dictionary: [:])
        if properties.contains(.providerManufacturer) {
            providerProperties.manufacturer = "broadify"
        }
        if properties.contains(.providerName) {
            providerProperties.name = "broadify Virtual Camera"
        }
        return providerProperties
    }

    func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {
        // No writable provider properties.
    }
}
