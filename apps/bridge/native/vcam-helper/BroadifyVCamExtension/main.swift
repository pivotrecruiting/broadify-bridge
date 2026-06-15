import CoreMediaIO
import Foundation

// Entry point of the CoreMediaIO camera extension. The system launches the
// extension on demand once it has been activated by the container app.
let providerSource = VCamProviderSource(clientQueue: nil)
CMIOExtensionProvider.startService(provider: providerSource.provider)

CFRunLoopRun()
