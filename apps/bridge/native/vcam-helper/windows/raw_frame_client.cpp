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
#include <cstring>

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
  if (thread_.joinable()) {
    thread_.join();
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
      Sleep(static_cast<DWORD>(backoffMs));
      backoffMs = std::min(backoffMs * kBackoffFactor, kBackoffMaxMs);
      continue;
    }

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port_);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);

    bool connected = false;
    if (connect(socket, reinterpret_cast<sockaddr *>(&address),
                sizeof(address)) == 0) {
      static const char kRequest[] =
          "GET /stream.rgba HTTP/1.1\r\n"
          "Host: 127.0.0.1\r\n"
          "Connection: close\r\n\r\n";
      if (send(socket, kRequest, static_cast<int>(sizeof(kRequest) - 1), 0) > 0) {
        // Consume the HTTP response headers up to the blank line; the raw
        // records begin immediately after.
        std::string handshake;
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
      VcamLog("RawFrameClient: connected to 127.0.0.1:%u", port_);
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

    closesocket(socket);
    if (running_.load()) {
      Sleep(static_cast<DWORD>(backoffMs));
      backoffMs = std::min(backoffMs * kBackoffFactor, kBackoffMaxMs);
    }
  }

  WSACleanup();
}

}  // namespace broadify::vcam
