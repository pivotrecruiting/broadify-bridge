import Darwin
import Foundation
import os.log

/**
 * Maintains a persistent local raw-frame stream from meeting-helper.
 *
 * The CMIO render timer must not perform per-frame socket I/O. A background
 * reader keeps the newest BGRA frame in memory and `copyLatestFrame` only
 * copies that cached frame into the CMIO pixel buffer.
 */
final class RawFrameStreamReader {
    private static let magic: UInt32 = 0x47524642
    private static let version: UInt32 = 1
    private static let pixelFormatRgba8: UInt32 = 1
    private static let pixelFormatBgra8: UInt32 = 2
    private static let headerSize = 32
    private static let frameMaxAgeSeconds = 2.0
    private static let reconnectInitialDelaySeconds = 0.25
    private static let reconnectMaxDelaySeconds = 3.0
    private static let log = OSLog(subsystem: "com.broadify.vcam.extension", category: "raw-frame-stream")

    private let host = "127.0.0.1"
    private let port: UInt16 = 18787
    private let lock = NSLock()
    private var shouldRun = false
    private var readerRunning = false
    private var activeSocketFd: Int32 = -1
    private var lastFailureLog = Date.distantPast
    private var reconnectDelaySeconds = reconnectInitialDelaySeconds
    private var latestBgra = [UInt8]()
    private var latestAt = Date.distantPast

    private(set) var width: UInt32 = 0
    private(set) var height: UInt32 = 0
    private(set) var publishedSeq: UInt64 = 0

    func start() {
        lock.lock()
        if readerRunning {
            shouldRun = true
            lock.unlock()
            return
        }
        shouldRun = true
        readerRunning = true
        reconnectDelaySeconds = Self.reconnectInitialDelaySeconds
        lock.unlock()

        Thread.detachNewThread { [weak self] in
            self?.readerLoop()
        }
    }

    func stop() {
        let socketFd: Int32
        lock.lock()
        shouldRun = false
        socketFd = activeSocketFd
        activeSocketFd = -1
        lock.unlock()

        if socketFd >= 0 {
            shutdown(socketFd, SHUT_RDWR)
        }
        clearLatestFrame(keepCapacity: false)
    }

    func hasFreshFrame() -> Bool {
        lock.lock()
        let hasFrame = !latestBgra.isEmpty &&
            Date().timeIntervalSince(latestAt) <= Self.frameMaxAgeSeconds &&
            width > 0 &&
            height > 0
        lock.unlock()

        return hasFrame
    }

    func copyLatestFrame(into dst: UnsafeMutablePointer<UInt8>, stride: Int) -> Bool {
        lock.lock()
        let frame = latestBgra
        let frameWidth = width
        let frameHeight = height
        let age = Date().timeIntervalSince(latestAt)
        lock.unlock()

        guard !frame.isEmpty,
              age <= Self.frameMaxAgeSeconds,
              frameWidth > 0,
              frameHeight > 0,
              stride >= Int(frameWidth) * 4 else {
            return false
        }

        frame.withUnsafeBytes { rawBytes in
            guard let srcBase = rawBytes.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                return
            }
            let rowBytes = Int(frameWidth) * 4
            for y in 0..<Int(frameHeight) {
                memcpy(dst + y * stride, srcBase + y * rowBytes, rowBytes)
            }
        }

        return true
    }

    private func isRunning() -> Bool {
        lock.lock()
        let running = shouldRun
        lock.unlock()
        return running
    }

    private func readerLoop() {
        while isRunning() {
            let connected = autoreleasepool {
                self.runSingleStreamSession()
            }
            self.clearLatestFrame(keepCapacity: connected)
            guard isRunning() else {
                break
            }
            if connected {
                reconnectDelaySeconds = Self.reconnectInitialDelaySeconds
            } else {
                Thread.sleep(forTimeInterval: reconnectDelaySeconds)
                reconnectDelaySeconds = min(
                    reconnectDelaySeconds * 1.8,
                    Self.reconnectMaxDelaySeconds
                )
            }
        }

        lock.lock()
        readerRunning = false
        reconnectDelaySeconds = Self.reconnectInitialDelaySeconds
        lock.unlock()
    }

    private func runSingleStreamSession() -> Bool {
        let socketFd = socket(AF_INET, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            logFailure("socket failed")
            return false
        }
        lock.lock()
        activeSocketFd = socketFd
        lock.unlock()
        defer {
            lock.lock()
            if activeSocketFd == socketFd {
                activeSocketFd = -1
            }
            lock.unlock()
            close(socketFd)
        }

        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(socketFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(socketFd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        inet_pton(AF_INET, host, &addr.sin_addr)

        let connected = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(socketFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard isRunning() else {
            return true
        }
        guard connected == 0 else {
            logFailure("Raw frame stream unavailable")
            return false
        }

        let request = "GET /stream.rgba HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        let sent = request.withCString { send(socketFd, $0, strlen($0), 0) }
        guard sent > 0 else {
            logFailure("Raw frame stream request failed")
            return false
        }

        guard readHttpHeaders(socketFd: socketFd) else {
            logFailure("Raw frame stream HTTP handshake failed")
            return false
        }

        os_log(.info, log: Self.log, "Connected to raw VCam frame stream")

        while isRunning() {
            guard let header = readExact(socketFd: socketFd, byteCount: Self.headerSize) else {
                logFailure("Raw frame stream disconnected")
                return true
            }
            let magic = readU32(header, 0)
            let version = readU32(header, 4)
            let frameWidth = readU32(header, 8)
            let frameHeight = readU32(header, 12)
            let pixelFormat = readU32(header, 16)
            let frameSize = readU32(header, 20)
            let seq = readU64(header, 24)
            let expectedFrameSize = Int(frameWidth) * Int(frameHeight) * 4

            guard magic == Self.magic,
                  version == Self.version,
                  (pixelFormat == Self.pixelFormatRgba8 || pixelFormat == Self.pixelFormatBgra8),
                  frameWidth > 0,
                  frameHeight > 0,
                  Int(frameSize) == expectedFrameSize,
                  expectedFrameSize <= 64 * 1024 * 1024 else {
                logFailure("Invalid raw frame stream header")
                return true
            }

            guard let rgba = readExact(socketFd: socketFd, byteCount: expectedFrameSize) else {
                logFailure("Raw frame stream payload incomplete")
                return true
            }
            publishFrame(bytes: rgba, pixelFormat: pixelFormat, width: frameWidth, height: frameHeight, seq: seq)
        }

        return true
    }

    private func publishFrame(bytes: [UInt8], pixelFormat: UInt32, width frameWidth: UInt32, height frameHeight: UInt32, seq: UInt64) {
        let bgra: [UInt8]
        if pixelFormat == Self.pixelFormatBgra8 {
            bgra = bytes
        } else {
            var converted = [UInt8](repeating: 0, count: bytes.count)
            let rowBytes = Int(frameWidth) * 4
            for y in 0..<Int(frameHeight) {
                let rowOffset = y * rowBytes
                for x in 0..<Int(frameWidth) {
                    let srcIndex = rowOffset + x * 4
                    let dstIndex = rowOffset + x * 4
                    converted[dstIndex + 0] = bytes[srcIndex + 2]
                    converted[dstIndex + 1] = bytes[srcIndex + 1]
                    converted[dstIndex + 2] = bytes[srcIndex + 0]
                    converted[dstIndex + 3] = bytes[srcIndex + 3]
                }
            }
            bgra = converted
        }

        lock.lock()
        latestBgra = bgra
        width = frameWidth
        height = frameHeight
        publishedSeq = seq
        latestAt = Date()
        lock.unlock()

        if seq == 1 || seq % 90 == 0 {
            os_log(.info, log: Self.log, "Buffered raw VCam frame seq=%{public}llu %{public}ux%{public}u",
                   seq, frameWidth, frameHeight)
        }
    }

    private func clearLatestFrame(keepCapacity: Bool) {
        lock.lock()
        latestBgra.removeAll(keepingCapacity: keepCapacity)
        width = 0
        height = 0
        latestAt = Date.distantPast
        lock.unlock()
    }

    private func readHttpHeaders(socketFd: Int32) -> Bool {
        var bytes = [UInt8]()
        var byte = [UInt8](repeating: 0, count: 1)
        while bytes.count < 8192 {
            let count = recv(socketFd, &byte, 1, 0)
            if count <= 0 {
                return false
            }
            bytes.append(byte[0])
            if bytes.suffix(4) == Array("\r\n\r\n".utf8) {
                let text = String(bytes: bytes, encoding: .utf8) ?? ""
                return text.contains("200 OK")
            }
        }
        return false
    }

    private func readExact(socketFd: Int32, byteCount: Int) -> [UInt8]? {
        var data = [UInt8](repeating: 0, count: byteCount)
        var offset = 0
        while offset < byteCount {
            let count = data.withUnsafeMutableBytes { rawBuffer -> Int in
                guard let base = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                    return -1
                }
                return recv(socketFd, base + offset, byteCount - offset, 0)
            }
            if count <= 0 {
                return nil
            }
            offset += count
        }
        return data
    }

    private func readU32(_ data: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(data[offset])
            | (UInt32(data[offset + 1]) << 8)
            | (UInt32(data[offset + 2]) << 16)
            | (UInt32(data[offset + 3]) << 24)
    }

    private func readU64(_ data: [UInt8], _ offset: Int) -> UInt64 {
        var value: UInt64 = 0
        for index in 0..<8 {
            value |= UInt64(data[offset + index]) << UInt64(index * 8)
        }
        return value
    }

    private func logFailure(_ message: StaticString) {
        let now = Date()
        guard now.timeIntervalSince(lastFailureLog) > 2 else {
            return
        }
        lastFailureLog = now
        os_log(.error, log: Self.log, message)
    }
}
