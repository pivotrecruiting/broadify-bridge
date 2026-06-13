import Foundation

/**
 * Swift wrapper around the C FrameBus shared-memory reader.
 *
 * The reader attaches to the shm segment written by the native meeting-helper
 * FrameBus producer and copies the latest
 * RGBA8 frame converted to BGRA8 for CoreVideo consumption.
 */
final class FrameBusReader {
    private var handle: OpaquePointer?
    private var lastSeq: UInt64 = 0
    private let name: String

    private(set) var width: UInt32 = 0
    private(set) var height: UInt32 = 0
    private(set) var fps: UInt32 = 0

    var isOpen: Bool { handle != nil }

    init(name: String) {
        self.name = name
    }

    deinit {
        close()
    }

    /// Try to attach to the shm segment. Safe to call repeatedly; the
    /// segment only exists while the meeting engine FrameBus output runs.
    @discardableResult
    func openIfNeeded() -> Bool {
        if handle != nil {
            return true
        }
        guard let opened = framebus_reader_open(name) else {
            return false
        }
        handle = opened
        framebus_reader_get_info(opened, &width, &height, &fps)
        lastSeq = 0
        return true
    }

    func close() {
        if let handle {
            framebus_reader_close(handle)
        }
        handle = nil
    }

    /**
     * Copy the newest frame into the destination buffer (BGRA8).
     * Returns true when a new frame was copied. On a torn read the
     * reader drops the segment and re-attaches on the next call.
     */
    func copyLatestFrame(into dst: UnsafeMutablePointer<UInt8>, stride: Int) -> Bool {
        guard let handle else {
            return false
        }
        let result = framebus_reader_copy_latest_bgra(handle, dst, stride, &lastSeq)
        if result == -2 {
            close()
            return false
        }
        return result == 1
    }
}
