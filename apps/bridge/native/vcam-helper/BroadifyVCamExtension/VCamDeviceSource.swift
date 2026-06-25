import CoreMediaIO
import CoreVideo
import Foundation
import IOKit.audio
import os.log

/// Output format used until the raw frame stream reports its own geometry.
private let kDefaultWidth = 1280
private let kDefaultHeight = 720
private let kDefaultFps = 30
private let kIdleSplashFps = 1.0

private let log = OSLog(subsystem: "com.broadify.vcam.extension", category: "device")

private enum VCamTimerMode: String {
    case idle
    case live
}

/**
 * Virtual camera device with a single streaming output.
 *
 * A dispatch timer copies the latest raw stream frame on every tick and
 * forwards it as a CMSampleBuffer. When no frame stream exists (engine stopped
 * or output disabled) a cached splash frame is sent instead so the camera stays
 * selectable in meeting apps without redrawing the idle frame at 30 fps.
 */
final class VCamDeviceSource: NSObject, CMIOExtensionDeviceSource {
    private(set) var device: CMIOExtensionDevice!
    private var streamSource: VCamStreamSource!

    private var timer: DispatchSourceTimer?
    private let timerQueue = DispatchQueue(label: "com.broadify.vcam.frame-timer", qos: .utility)

    private let rawFrameStreamReader = RawFrameStreamReader()
    private var bufferPool: CVPixelBufferPool?
    private var formatDescription: CMFormatDescription?
    private var outputPixelBuffer: CVPixelBuffer?
    private var splashPixelBuffer: CVPixelBuffer?
    private var timerMode: VCamTimerMode = .idle
    private var currentWidth = kDefaultWidth
    private var currentHeight = kDefaultHeight
    private var streamingCounter = 0

    init(localizedName: String) {
        super.init()
        os_log(.info, log: log, "Initializing CMIO device source")
        let deviceID = UUID()
        device = CMIOExtensionDevice(
            localizedName: localizedName,
            deviceID: deviceID,
            legacyDeviceID: nil,
            source: self
        )

        rebuildVideoFormat(width: kDefaultWidth, height: kDefaultHeight)

        let videoStreamFormat = CMIOExtensionStreamFormat(
            formatDescription: formatDescription!,
            maxFrameDuration: CMTime(value: 1, timescale: Int32(kDefaultFps)),
            minFrameDuration: CMTime(value: 1, timescale: Int32(kDefaultFps)),
            validFrameDurations: nil
        )
        streamSource = VCamStreamSource(
            localizedName: "broadify Camera Stream",
            streamID: UUID(),
            streamFormat: videoStreamFormat,
            device: device
        )

        do {
            try device.addStream(streamSource.stream)
            os_log(.info, log: log, "CMIO stream registration succeeded")
        } catch {
            os_log(.fault, log: log, "Failed to add stream: %{public}@", error.localizedDescription)
            fatalError("Failed to add stream: \(error.localizedDescription)")
        }
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.deviceTransportType, .deviceModel]
    }

    func deviceProperties(
        forProperties properties: Set<CMIOExtensionProperty>
    ) throws -> CMIOExtensionDeviceProperties {
        let deviceProperties = CMIOExtensionDeviceProperties(dictionary: [:])
        if properties.contains(.deviceTransportType) {
            deviceProperties.transportType = kIOAudioDeviceTransportTypeVirtual
        }
        if properties.contains(.deviceModel) {
            deviceProperties.model = "broadify Virtual Camera"
        }
        return deviceProperties
    }

    func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {
        // No writable device properties.
    }

    func startStreaming() {
        streamingCounter += 1
        guard timer == nil else {
            return
        }

        rawFrameStreamReader.start()
        let timer = DispatchSource.makeTimerSource(queue: timerQueue)
        timer.setEventHandler { [weak self] in
            self?.emitFrame()
        }
        self.timer = timer
        scheduleTimer(mode: .idle, deadline: .now())
        timer.resume()
        os_log(.info, log: log, "Streaming started clients=%{public}d", streamingCounter)
    }

    func stopStreaming() {
        streamingCounter = max(0, streamingCounter - 1)
        guard streamingCounter == 0 else {
            return
        }
        timer?.cancel()
        timer = nil
        timerMode = .idle
        rawFrameStreamReader.stop()
        os_log(.info, log: log, "Streaming stopped clients=0")
    }

    // MARK: - Frame production

    private func scheduleTimer(mode: VCamTimerMode, deadline: DispatchTime = .now() + .milliseconds(1)) {
        guard let timer else {
            return
        }
        timerMode = mode
        let frameInterval = mode == .live ? 1.0 / Double(kDefaultFps) : 1.0 / kIdleSplashFps
        let leeway: DispatchTimeInterval = mode == .live ? .milliseconds(2) : .milliseconds(100)
        timer.schedule(deadline: deadline, repeating: frameInterval, leeway: leeway)
        os_log(.info, log: log, "VCam timer mode=%{public}@", mode.rawValue)
    }

    private func switchTimerModeIfNeeded(_ mode: VCamTimerMode) {
        guard timerMode != mode else {
            return
        }
        scheduleTimer(mode: mode)
    }

    private func emitFrame() {
        guard let pool = bufferPool, let formatDescription else {
            return
        }

        guard rawFrameStreamReader.hasFreshFrame() else {
            switchTimerModeIfNeeded(.idle)
            sendSplashFrame(formatDescription: formatDescription, pool: pool)
            return
        }

        switchTimerModeIfNeeded(.live)
        let streamWidth = Int(rawFrameStreamReader.width)
        let streamHeight = Int(rawFrameStreamReader.height)
        if streamWidth > 0,
           streamHeight > 0,
           streamWidth != currentWidth || streamHeight != currentHeight {
            rebuildVideoFormat(width: streamWidth, height: streamHeight)
            return
        }

        let pixelBuffer: CVPixelBuffer
        if let cachedPixelBuffer = outputPixelBuffer {
            pixelBuffer = cachedPixelBuffer
        } else {
            var createdPixelBuffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &createdPixelBuffer)
            guard let createdPixelBuffer else {
                return
            }
            outputPixelBuffer = createdPixelBuffer
            pixelBuffer = createdPixelBuffer
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return
        }
        let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let dst = baseAddress.assumingMemoryBound(to: UInt8.self)

        let hasFrame = rawFrameStreamReader.copyLatestFrame(into: dst, stride: stride)
        if hasFrame {
            sendPixelBuffer(pixelBuffer, formatDescription: formatDescription)
            return
        }

        os_log(.debug, log: log, "No VCam raw frame (seq=%{public}llu)",
               rawFrameStreamReader.publishedSeq)
        switchTimerModeIfNeeded(.idle)
        sendSplashFrame(formatDescription: formatDescription, pool: pool)
    }

    private func sendSplashFrame(
        formatDescription: CMFormatDescription,
        pool: CVPixelBufferPool
    ) {
        if let splashPixelBuffer {
            sendPixelBuffer(splashPixelBuffer, formatDescription: formatDescription)
            return
        }

        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBuffer)
        guard let pixelBuffer else {
            return
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return
        }
        let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let dst = baseAddress.assumingMemoryBound(to: UInt8.self)

        drawSplashFrame(dst: dst, stride: stride)
        splashPixelBuffer = pixelBuffer
        sendPixelBuffer(pixelBuffer, formatDescription: formatDescription)
    }

    private func sendPixelBuffer(
        _ pixelBuffer: CVPixelBuffer,
        formatDescription: CMFormatDescription
    ) {
        var sampleBuffer: CMSampleBuffer?
        var timingInfo = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: Int32(kDefaultFps)),
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDescription,
            sampleTiming: &timingInfo,
            sampleBufferOut: &sampleBuffer
        )

        if let sampleBuffer {
            streamSource.stream.send(
                sampleBuffer,
                discontinuity: [],
                hostTimeInNanoseconds: UInt64(
                    timingInfo.presentationTimeStamp.seconds * Double(NSEC_PER_SEC)
                )
            )
        }
    }

    /// Dark gray frame with a centered lighter block, signalling "no signal".
    private func drawSplashFrame(dst: UnsafeMutablePointer<UInt8>, stride: Int) {
        let width = currentWidth
        let height = currentHeight
        for y in 0..<height {
            let row = dst + y * stride
            for x in 0..<width {
                let isCenterBlock =
                    x > width * 2 / 5 && x < width * 3 / 5 &&
                    y > height * 2 / 5 && y < height * 3 / 5
                let value: UInt8 = isCenterBlock ? 64 : 24
                row[x * 4 + 0] = value
                row[x * 4 + 1] = value
                row[x * 4 + 2] = value
                row[x * 4 + 3] = 255
            }
        }
    }

    private func rebuildVideoFormat(width: Int, height: Int) {
        currentWidth = width
        currentHeight = height

        var description: CMFormatDescription?
        CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            codecType: kCVPixelFormatType_32BGRA,
            width: Int32(width),
            height: Int32(height),
            extensions: nil,
            formatDescriptionOut: &description
        )
        formatDescription = description

        let poolAttributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            nil,
            poolAttributes as CFDictionary,
            &pool
        )
        bufferPool = pool
        outputPixelBuffer = nil
        splashPixelBuffer = nil
    }
}

/**
 * Streaming output of the virtual camera device.
 */
final class VCamStreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) var stream: CMIOExtensionStream!
    private let streamFormat: CMIOExtensionStreamFormat
    private weak var device: CMIOExtensionDevice?

    init(
        localizedName: String,
        streamID: UUID,
        streamFormat: CMIOExtensionStreamFormat,
        device: CMIOExtensionDevice
    ) {
        self.streamFormat = streamFormat
        self.device = device
        super.init()
        stream = CMIOExtensionStream(
            localizedName: localizedName,
            streamID: streamID,
            direction: .source,
            clockType: .hostTime,
            source: self
        )
    }

    var formats: [CMIOExtensionStreamFormat] {
        [streamFormat]
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration]
    }

    func streamProperties(
        forProperties properties: Set<CMIOExtensionProperty>
    ) throws -> CMIOExtensionStreamProperties {
        let streamProperties = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) {
            streamProperties.activeFormatIndex = 0
        }
        if properties.contains(.streamFrameDuration) {
            streamProperties.frameDuration = CMTime(value: 1, timescale: Int32(kDefaultFps))
        }
        return streamProperties
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        // Single fixed format; nothing to apply.
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        true
    }

    func startStream() throws {
        guard let deviceSource = device?.source as? VCamDeviceSource else {
            throw NSError(
                domain: "com.broadify.vcam",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing device source"]
            )
        }
        deviceSource.startStreaming()
    }

    func stopStream() throws {
        guard let deviceSource = device?.source as? VCamDeviceSource else {
            return
        }
        deviceSource.stopStreaming()
    }
}
