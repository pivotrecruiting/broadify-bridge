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
    private static let headerSize = 32
    private static let frameMaxAgeSeconds = 2.0
    private static let log = OSLog(subsystem: "com.broadify.vcam.extension", category: "raw-frame-stream")

    private let host = "127.0.0.1"
    private let port: UInt16 = 18787
    private let lock = NSLock()
    private var readerStarted = false
    private var lastFailureLog = Date.distantPast
    private var latestBgra = [UInt8]()
    private var latestAt = Date.distantPast

    private(set) var width: UInt32 = 0
    private(set) var height: UInt32 = 0
    private(set) var publishedSeq: UInt64 = 0

    func copyLatestFrame(into dst: UnsafeMutablePointer<UInt8>, stride: Int) -> Bool {
        startReaderIfNeeded()

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

    private func startReaderIfNeeded() {
        lock.lock()
        if readerStarted {
            lock.unlock()
            return
        }
        readerStarted = true
        lock.unlock()

        Thread.detachNewThread { [weak self] in
            self?.readerLoop()
        }
    }

    private func readerLoop() {
        while true {
            autoreleasepool {
                self.runSingleStreamSession()
            }
            self.clearLatestFrame()
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    private func runSingleStreamSession() {
        let socketFd = socket(AF_INET, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            logFailure("socket failed")
            return
        }
        defer { close(socketFd) }

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
        guard connected == 0 else {
            logFailure("Raw frame stream unavailable")
            return
        }

        let request = "GET /stream.rgba HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        let sent = request.withCString { send(socketFd, $0, strlen($0), 0) }
        guard sent > 0 else {
            logFailure("Raw frame stream request failed")
            return
        }

        guard readHttpHeaders(socketFd: socketFd) else {
            logFailure("Raw frame stream HTTP handshake failed")
            return
        }

        os_log(.info, log: Self.log, "Connected to raw VCam frame stream")

        while true {
            guard let header = readExact(socketFd: socketFd, byteCount: Self.headerSize) else {
                logFailure("Raw frame stream disconnected")
                return
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
                  pixelFormat == Self.pixelFormatRgba8,
                  frameWidth > 0,
                  frameHeight > 0,
                  Int(frameSize) == expectedFrameSize,
                  expectedFrameSize <= 64 * 1024 * 1024 else {
                logFailure("Invalid raw frame stream header")
                return
            }

            guard let rgba = readExact(socketFd: socketFd, byteCount: expectedFrameSize) else {
                logFailure("Raw frame stream payload incomplete")
                return
            }
            publishFrame(rgba: rgba, width: frameWidth, height: frameHeight, seq: seq)
        }
    }

    private func publishFrame(rgba: [UInt8], width frameWidth: UInt32, height frameHeight: UInt32, seq: UInt64) {
        var bgra = [UInt8](repeating: 0, count: rgba.count)
        let rowBytes = Int(frameWidth) * 4
        for y in 0..<Int(frameHeight) {
            let rowOffset = y * rowBytes
            for x in 0..<Int(frameWidth) {
                let srcIndex = rowOffset + x * 4
                let dstIndex = rowOffset + x * 4
                bgra[dstIndex + 0] = rgba[srcIndex + 2]
                bgra[dstIndex + 1] = rgba[srcIndex + 1]
                bgra[dstIndex + 2] = rgba[srcIndex + 0]
                bgra[dstIndex + 3] = rgba[srcIndex + 3]
            }
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

    private func clearLatestFrame() {
        lock.lock()
        latestBgra.removeAll(keepingCapacity: false)
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
