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
#include <string>

#pragma comment(lib, "ws2_32.lib")

namespace broadify::vcam {
namespace {

constexpr uint32_t kRawFrameMagic = 0x47524642u;  // "BFRG" little endian.
constexpr uint32_t kRawFramePixelFormatBgra8 = 2u;
constexpr size_t kRecordHeaderSize = 32u;
constexpr uint32_t kMaxDimension = 7680u;  // guard against corrupt headers.
constexpr uint64_t kStaleWindowMs = 2000u;

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
      return false;
    }
    received += static_cast<size_t>(chunk);
  }
  return true;
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
    // Wake a recv()/connect() that is blocked on the live socket; the run
    // loop owns the handle and closes it once it observes running_ == false.
    std::lock_guard<std::mutex> lock(socketMutex_);
    if (activeSocket_ != kNoSocket) {
      shutdown(static_cast<SOCKET>(activeSocket_), SD_BOTH);
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
  std::lock_guard<std::mutex> lock(mutex_);
  if (!hasFrame_) {
    return true;
  }
  return GetTickCount64() - lastArrivalMs_ > kStaleWindowMs;
}

void RawFrameClient::run() {
  WSADATA wsaData;
  if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
    VcamLog("RawFrameClient: WSAStartup failed");
    return;
  }

  double backoffMs = kBackoffStartMs;
  while (running_.load()) {
    SOCKET socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket == INVALID_SOCKET) {
      sleepWhileRunning(backoffMs);
      backoffMs = std::min(backoffMs * kBackoffFactor, kBackoffMaxMs);
      continue;
    }
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
            connected = false;
            break;
          }
          handshake.push_back(byte);
          if (handshake.size() > 8192) {  // malformed / unbounded header.
            connected = false;
            break;
          }
        }
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

      uint8_t header[kRecordHeaderSize];
      std::vector<uint8_t> payload;
      while (running_.load()) {
        if (!recvExact(socket, header, kRecordHeaderSize, running_)) {
          break;
        }
        if (readU32Le(header) != kRawFrameMagic) {
          VcamLog("RawFrameClient: bad magic, resyncing");
          break;
        }
        const uint32_t width = readU32Le(header + 8);
        const uint32_t height = readU32Le(header + 12);
        const uint32_t pixelFormat = readU32Le(header + 16);
        const uint32_t frameSize = readU32Le(header + 20);
        const uint64_t sequence = readU64Le(header + 24);
        if (width == 0 || height == 0 || width > kMaxDimension ||
            height > kMaxDimension || pixelFormat != kRawFramePixelFormatBgra8 ||
            frameSize != width * height * 4u) {
          VcamLog("RawFrameClient: invalid header %ux%u fmt=%u size=%u", width,
                  height, pixelFormat, frameSize);
          break;
        }
        payload.resize(frameSize);
        if (!recvExact(socket, payload.data(), frameSize, running_)) {
          break;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        latest_.width = width;
        latest_.height = height;
        latest_.sequence = sequence;
        latest_.bgra = payload;
        hasFrame_ = true;
        lastArrivalMs_ = GetTickCount64();
      }
    }

    {
      std::lock_guard<std::mutex> lock(socketMutex_);
      activeSocket_ = kNoSocket;
    }
    closesocket(socket);
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
