#include "raw_frame_client.h"

#include "vcam_log.h"

#ifndef NOMINMAX
#define NOMINMAX  // keep std::min/std::max from clashing with windows.h macros.
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <exception>
#include <string>

#pragma comment(lib, "ws2_32.lib")

namespace broadify::vcam {
namespace {

constexpr uint32_t kRawFrameMagic = 0x47524642u;  // "BFRG" little endian.
constexpr uint32_t kRawFrameVersion1 = 1u;
constexpr uint32_t kRawFrameVersion2 = 2u;
constexpr uint32_t kRawFramePixelFormatBgra8 = 2u;
constexpr size_t kRecordHeaderV1Size = 32u;
constexpr size_t kRecordHeaderV2Size = 40u;
constexpr uint32_t kMaxDimension = 7680u;  // guard against corrupt headers.
constexpr uint64_t kStaleWindowMs = 2000u;
constexpr uint64_t kVeryStaleWindowMs = 10000u;
constexpr DWORD kSocketTimeoutMs = 5000;

constexpr double kBackoffStartMs = 250.0;
constexpr double kBackoffMaxMs = 3000.0;
constexpr double kBackoffFactor = 1.8;

uint32_t readU32Le(const uint8_t *p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

uint64_t readU64Le(const uint8_t *p) {
  uint64_t value = 0;
  for (int i = 0; i < 8; i++) {
    value |= static_cast<uint64_t>(p[i]) << (8 * i);
  }
  return value;
}

// Reads exactly len bytes into buffer unless running clears or the socket
// closes. Returns false on error/shutdown.
bool recvExact(SOCKET socket, uint8_t *buffer, size_t len,
               const std::atomic<bool> &running) {
  size_t received = 0;
  while (received < len) {
    if (!running.load()) {
      return false;
    }
    const int chunk = recv(socket, reinterpret_cast<char *>(buffer + received),
                           static_cast<int>(len - received), 0);
    if (chunk <= 0) {
      const int error = WSAGetLastError();
      if (chunk == SOCKET_ERROR &&
          (error == WSAETIMEDOUT || error == WSAEWOULDBLOCK)) {
        VcamLog("RawFrameClient: recv timeout/disconnect error=%d", error);
      } else if (chunk == SOCKET_ERROR) {
        VcamLog("RawFrameClient: recv failed error=%d", error);
      }
      return false;
    }
    received += static_cast<size_t>(chunk);
  }
  return true;
}

void configureSocket(SOCKET socket) {
  const DWORD timeoutMs = kSocketTimeoutMs;
  setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO,
             reinterpret_cast<const char *>(&timeoutMs), sizeof(timeoutMs));
  setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO,
             reinterpret_cast<const char *>(&timeoutMs), sizeof(timeoutMs));
  const BOOL keepAlive = TRUE;
  setsockopt(socket, SOL_SOCKET, SO_KEEPALIVE,
             reinterpret_cast<const char *>(&keepAlive), sizeof(keepAlive));
}

// Finds a header line `name: value` in the HTTP handshake block (names are
// case-insensitive per RFC 7230) and parses the value as an unsigned integer.
// Returns false when the header is missing or the value is not a plain
// decimal number. Tolerates surrounding whitespace in the value.
bool parseHeaderU32(const std::string &handshake, const char *name,
                    uint32_t &out) {
  std::string lowered(handshake.size(), '\0');
  for (size_t i = 0; i < handshake.size(); i++) {
    lowered[i] = static_cast<char>(
        std::tolower(static_cast<unsigned char>(handshake[i])));
  }
  std::string key = "\r\n";
  for (const char *c = name; *c; ++c) {
    key.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(*c))));
  }
  key.push_back(':');
  const size_t at = lowered.find(key);
  if (at == std::string::npos) {
    return false;
  }
  size_t pos = at + key.size();
  const size_t end = handshake.find("\r\n", pos);
  if (end == std::string::npos) {
    return false;
  }
  while (pos < end && (handshake[pos] == ' ' || handshake[pos] == '\t')) {
    pos++;
  }
  uint64_t value = 0;
  size_t digits = 0;
  while (pos < end && handshake[pos] >= '0' && handshake[pos] <= '9') {
    value = value * 10u + static_cast<uint64_t>(handshake[pos] - '0');
    if (value > 0xffffffffull) {
      return false;
    }
    pos++;
    digits++;
  }
  while (pos < end && (handshake[pos] == ' ' || handshake[pos] == '\t')) {
    pos++;
  }
  if (digits == 0 || pos != end) {
    return false;
  }
  out = static_cast<uint32_t>(value);
  return true;
}

}  // namespace

RawFrameClient::RawFrameClient(uint16_t port) : port_(port) {}

RawFrameClient::~RawFrameClient() { stop(); }

void RawFrameClient::start() {
  if (running_.exchange(true)) {
    return;
  }
  thread_ = std::thread(&RawFrameClient::run, this);
}

void RawFrameClient::stop() {
  if (!running_.exchange(false)) {
    return;
  }
  {
    // Wake a recv()/connect() that is blocked on the live socket.
    std::lock_guard<std::mutex> lock(socketMutex_);
    if (activeSocket_ != kNoSocket) {
      const SOCKET socket = static_cast<SOCKET>(activeSocket_);
      shutdown(socket, SD_BOTH);
      closesocket(socket);
      activeSocket_ = kNoSocket;
    }
  }
  if (thread_.joinable()) {
    thread_.join();
  }
}

void RawFrameClient::sleepWhileRunning(double ms) const {
  constexpr DWORD kSliceMs = 50;
  DWORD remaining = static_cast<DWORD>(ms);
  while (remaining > 0 && running_.load()) {
    const DWORD slice = std::min(remaining, kSliceMs);
    Sleep(slice);
    remaining -= slice;
  }
}

bool RawFrameClient::copyLatest(RawFrame &out) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!hasFrame_) {
    return false;
  }
  out = latest_;
  return true;
}

bool RawFrameClient::copyLatestIfNew(uint64_t lastSequence, RawFrame &out) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!hasFrame_ || latest_.sequence == lastSequence) {
    return false;
  }
  out = latest_;
  return true;
}

bool RawFrameClient::streamGeometry(uint32_t &width, uint32_t &height) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!hasStreamGeometry_) {
    return false;
  }
  width = streamWidth_;
  height = streamHeight_;
  return true;
}

bool RawFrameClient::isStale() const {
  return staleAgeMs() > kStaleWindowMs;
}

uint64_t RawFrameClient::staleAgeMs() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!hasFrame_) {
    return UINT64_MAX;
  }
  return GetTickCount64() - lastArrivalMs_;
}

void RawFrameClient::run() {
  try {
    runLoop();
  } catch (const std::exception &error) {
    VcamLog("RawFrameClient: thread exception: %s", error.what());
  } catch (...) {
    VcamLog("RawFrameClient: thread exception");
  }
}

void RawFrameClient::runLoop() {
  WSADATA wsaData;
  if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
    VcamLog("RawFrameClient: WSAStartup failed");
    return;
  }

  double backoffMs = kBackoffStartMs;
  double lastLoggedConnectBackoffMs = 0.0;
  while (running_.load()) {
    SOCKET socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket == INVALID_SOCKET) {
      sleepWhileRunning(backoffMs);
      backoffMs = std::min(backoffMs * kBackoffFactor, kBackoffMaxMs);
      continue;
    }
    configureSocket(socket);
    {
      std::lock_guard<std::mutex> lock(socketMutex_);
      activeSocket_ = static_cast<uintptr_t>(socket);
    }
    if (!running_.load()) {
      // stop() may have raced the publication above; do not connect.
      std::lock_guard<std::mutex> lock(socketMutex_);
      activeSocket_ = kNoSocket;
      closesocket(socket);
      break;
    }

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port_);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);

    bool connected = false;
    std::string handshake;
    if (connect(socket, reinterpret_cast<sockaddr *>(&address),
                sizeof(address)) == 0) {
      lastLoggedConnectBackoffMs = 0.0;
      static const char kRequest[] =
          "GET /stream.rgba HTTP/1.1\r\n"
          "Host: 127.0.0.1\r\n"
          "Connection: close\r\n\r\n";
      if (send(socket, kRequest, static_cast<int>(sizeof(kRequest) - 1), 0) > 0) {
        // Consume the HTTP response headers up to the blank line; the raw
        // records begin immediately after.
        char byte = 0;
        connected = true;
        while (running_.load() && handshake.find("\r\n\r\n") == std::string::npos) {
          const int n = recv(socket, &byte, 1, 0);
          if (n <= 0) {
            const int error = WSAGetLastError();
            if (n == SOCKET_ERROR &&
                (error == WSAETIMEDOUT || error == WSAEWOULDBLOCK)) {
              VcamLog("RawFrameClient: handshake timeout error=%d", error);
            } else if (n == SOCKET_ERROR) {
              VcamLog("RawFrameClient: handshake recv failed error=%d", error);
            }
            connected = false;
            break;
          }
          handshake.push_back(byte);
          if (handshake.size() > 8192) {  // malformed / unbounded header.
            connected = false;
            break;
          }
        }
      } else {
        VcamLog("RawFrameClient: handshake send failed error=%d", WSAGetLastError());
      }
    } else {
      const int error = WSAGetLastError();
      if (lastLoggedConnectBackoffMs == 0.0 ||
          lastLoggedConnectBackoffMs != backoffMs) {
        VcamLog("RawFrameClient: connect failed error=%d backoff_ms=%.0f", error,
                backoffMs);
        lastLoggedConnectBackoffMs = backoffMs;
      }
    }

    if (connected) {
      // The helper advertises its configured program geometry in the
      // handshake; publish it before the first frame so a geometry probe can
      // finish even while the pipeline is still busy starting up. Older
      // helpers without the headers simply leave it unset.
      uint32_t streamWidth = 0;
      uint32_t streamHeight = 0;
      if (parseHeaderU32(handshake, "X-Broadify-Frame-Width", streamWidth) &&
          parseHeaderU32(handshake, "X-Broadify-Frame-Height", streamHeight) &&
          streamWidth > 0 && streamHeight > 0 && streamWidth <= kMaxDimension &&
          streamHeight <= kMaxDimension) {
        std::lock_guard<std::mutex> lock(mutex_);
        hasStreamGeometry_ = true;
        streamWidth_ = streamWidth;
        streamHeight_ = streamHeight;
        VcamLog("RawFrameClient: handshake geometry %ux%u", streamWidth,
                streamHeight);
      } else {
        VcamLog("RawFrameClient: handshake without geometry headers");
      }
      VcamLog("RawFrameClient: connected to 127.0.0.1:%u (stream consumer active)", port_);
      backoffMs = kBackoffStartMs;

      uint8_t header[kRecordHeaderV2Size];
      std::vector<uint8_t> payload;
      uint64_t lastStaleLogWindowMs = 0;
      while (running_.load()) {
        if (!recvExact(socket, header, kRecordHeaderV1Size, running_)) {
          break;
        }
        if (readU32Le(header) != kRawFrameMagic) {
          VcamLog("RawFrameClient: bad magic, resyncing");
          break;
        }
        const uint32_t version = readU32Le(header + 4);
        if (version != kRawFrameVersion1 && version != kRawFrameVersion2) {
          VcamLog("RawFrameClient: unsupported BFRG version %u", version);
          break;
        }
        if (version == kRawFrameVersion2 &&
            !recvExact(socket, header + kRecordHeaderV1Size,
                       kRecordHeaderV2Size - kRecordHeaderV1Size, running_)) {
          break;
        }
        const uint32_t width = readU32Le(header + 8);
        const uint32_t height = readU32Le(header + 12);
        const uint32_t pixelFormat = readU32Le(header + 16);
        const uint32_t frameSize = readU32Le(header + 20);
        const uint64_t sequence = readU64Le(header + 24);
        const uint64_t captureNs =
            version == kRawFrameVersion2 ? readU64Le(header + 32) : 0;
        if (width == 0 || height == 0 || width > kMaxDimension ||
            height > kMaxDimension || pixelFormat != kRawFramePixelFormatBgra8 ||
            frameSize != width * height * 4u) {
          VcamLog("RawFrameClient: invalid header %ux%u fmt=%u size=%u", width,
                  height, pixelFormat, frameSize);
          break;
        }
        if (payload.size() != frameSize) {
          payload.resize(frameSize);
        }
        if (!recvExact(socket, payload.data(), frameSize, running_)) {
          break;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        latest_.width = width;
        latest_.height = height;
        latest_.sequence = sequence;
        latest_.captureNs = captureNs;
        if (latest_.bgra.size() != payload.size()) {
          latest_.bgra.resize(payload.size());
        }
        std::memcpy(latest_.bgra.data(), payload.data(), payload.size());
        hasFrame_ = true;
        lastArrivalMs_ = GetTickCount64();
        lastStaleLogWindowMs = 0;
      }
      uint64_t staleMs = 0;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (hasFrame_) {
          staleMs = GetTickCount64() - lastArrivalMs_;
        }
      }
      if (staleMs >= kVeryStaleWindowMs &&
          lastStaleLogWindowMs != kVeryStaleWindowMs) {
        VcamLog("RawFrameClient: no frames for %llu ms",
                static_cast<unsigned long long>(staleMs));
        lastStaleLogWindowMs = kVeryStaleWindowMs;
      } else if (staleMs >= kStaleWindowMs &&
                 lastStaleLogWindowMs != kStaleWindowMs) {
        VcamLog("RawFrameClient: no frames for %llu ms",
                static_cast<unsigned long long>(staleMs));
        lastStaleLogWindowMs = kStaleWindowMs;
      }
    }

    bool shouldClose = true;
    {
      std::lock_guard<std::mutex> lock(socketMutex_);
      shouldClose = activeSocket_ == static_cast<uintptr_t>(socket);
      if (shouldClose) {
        activeSocket_ = kNoSocket;
      }
    }
    if (shouldClose) {
      closesocket(socket);
    }
    if (connected) {
      VcamLog("RawFrameClient: disconnected from 127.0.0.1:%u", port_);
    }
    if (running_.load()) {
      sleepWhileRunning(backoffMs);
      backoffMs = std::min(backoffMs * kBackoffFactor, kBackoffMaxMs);
    }
  }

  WSACleanup();
}

}  // namespace broadify::vcam
