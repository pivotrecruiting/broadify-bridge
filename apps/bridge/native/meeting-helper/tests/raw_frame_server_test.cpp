#include "preview/raw_frame_server.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <winsock2.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

using broadify::meeting::MeetingState;
using broadify::meeting::PreviewFrameStore;
using broadify::meeting::RawFrameStreamGeometry;
using broadify::meeting::reapCompletedRawFrameWorkers;
using broadify::meeting::runRawFrameServer;

constexpr uint32_t kRawFrameMagic = 0x47524642u;
constexpr size_t kRawFrameHeaderSize = 40u;
constexpr uint64_t kRawFrameHeartbeatSequenceMask = 1ull << 63;

void fail(const char *message) {
  std::cerr << "raw_frame_server_test failed: " << message << std::endl;
  std::exit(1);
}

void closeSocketHandle(int socketHandle) {
#if defined(_WIN32)
  closesocket(socketHandle);
#else
  close(socketHandle);
#endif
}

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

bool recvExact(int socketHandle, uint8_t *data, size_t size) {
  size_t received = 0;
  while (received < size) {
    const int result =
        recv(socketHandle, reinterpret_cast<char *>(data + received),
             static_cast<int>(size - received), 0);
    if (result <= 0) {
      return false;
    }
    received += static_cast<size_t>(result);
  }
  return true;
}

uint16_t reservePort() {
  const int socketHandle = static_cast<int>(socket(AF_INET, SOCK_STREAM, 0));
  if (socketHandle < 0) {
    fail("socket");
  }
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;
  if (bind(socketHandle, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) !=
      0) {
    fail("bind port 0");
  }
  sockaddr_in actual{};
#if defined(_WIN32)
  int len = sizeof(actual);
#else
  socklen_t len = sizeof(actual);
#endif
  if (getsockname(socketHandle, reinterpret_cast<sockaddr *>(&actual), &len) !=
      0) {
    fail("getsockname");
  }
  const uint16_t port = ntohs(actual.sin_port);
  closeSocketHandle(socketHandle);
  return port;
}

int connectClient(uint16_t port) {
  const int socketHandle = static_cast<int>(socket(AF_INET, SOCK_STREAM, 0));
  if (socketHandle < 0) {
    fail("client socket");
  }
#if defined(_WIN32)
  const int timeoutMs = 3000;
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO,
             reinterpret_cast<const char *>(&timeoutMs), sizeof(timeoutMs));
#else
  timeval timeout{};
  timeout.tv_sec = 3;
  timeout.tv_usec = 0;
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO,
             reinterpret_cast<const char *>(&timeout), sizeof(timeout));
#endif
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(port);
  if (connect(socketHandle, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) !=
      0) {
    fail("connect");
  }
  const char request[] =
      "GET /stream.rgba HTTP/1.1\r\n"
      "Host: 127.0.0.1\r\n"
      "X-Broadify-Accepts: keepalive-v2\r\n"
      "Connection: close\r\n\r\n";
  if (send(socketHandle, request, static_cast<int>(sizeof(request) - 1), 0) <=
      0) {
    fail("send request");
  }
  return socketHandle;
}

std::string readHttpHeader(int socketHandle) {
  std::string header;
  char byte = 0;
  while (header.find("\r\n\r\n") == std::string::npos) {
    const int result = recv(socketHandle, &byte, 1, 0);
    if (result <= 0) {
      fail("read http header");
    }
    header.push_back(byte);
    if (header.size() > 4096) {
      fail("oversized http header");
    }
  }
  return header;
}

uint64_t readFrameSequence(int socketHandle) {
  std::vector<uint8_t> header(kRawFrameHeaderSize);
  if (!recvExact(socketHandle, header.data(), header.size())) {
    fail("read raw frame header");
  }
  if (readU32Le(header.data()) != kRawFrameMagic) {
    fail("bad raw frame magic");
  }
  const uint32_t payloadSize = readU32Le(header.data() + 20);
  std::vector<uint8_t> payload(payloadSize);
  if (!recvExact(socketHandle, payload.data(), payload.size())) {
    fail("read raw frame payload");
  }
  return readU64Le(header.data() + 24);
}

void assertDisarmedHandshake(uint16_t port, MeetingState &state) {
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = false;
  }
  const int client = connectClient(port);
  const std::string header = readHttpHeader(client);
  closeSocketHandle(client);
  if (header.find("HTTP/1.1 503 Service Unavailable\r\n") ==
      std::string::npos) {
    fail("disarmed stream must return HTTP 503");
  }
  if (header.find("X-Broadify-Stream: disarmed\r\n") == std::string::npos) {
    fail("disarmed stream must advertise disarmed status");
  }
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = true;
  }
}

}  // namespace

int main() {
  const std::vector<bool> survivors =
      reapCompletedRawFrameWorkers({false, true, false, true});
  if (survivors.size() != 2u || survivors[0] || survivors[1]) {
    fail("completed raw-frame workers must be reaped");
  }

#if defined(_WIN32)
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

  const uint16_t port = reservePort();
  PreviewFrameStore previewFrames;
  MeetingState state;
  std::atomic<bool> running{true};
  RawFrameStreamGeometry geometry{2, 2, 30};

  std::thread server([&] {
    runRawFrameServer(port, geometry, previewFrames, state, running);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  assertDisarmedHandshake(port, state);

  const int emptyClient = connectClient(port);
  (void)readHttpHeader(emptyClient);
  const uint64_t emptyHeartbeat = readFrameSequence(emptyClient);
  if ((emptyHeartbeat & kRawFrameHeartbeatSequenceMask) == 0u) {
    fail("empty stream heartbeat sequence must use the high-bit namespace");
  }
  closeSocketHandle(emptyClient);

  const uint8_t rgba[16] = {
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
  };
  previewFrames.publish(2, 2, rgba, sizeof(rgba));

  const int clientA = connectClient(port);
  const int clientB = connectClient(port);
  (void)readHttpHeader(clientA);
  (void)readHttpHeader(clientB);

  const uint64_t firstA = readFrameSequence(clientA);
  const uint64_t firstB = readFrameSequence(clientB);
  if (firstA == 0 || firstB == 0) {
    fail("both clients must receive an initial frame");
  }

  const auto heartbeatStart = std::chrono::steady_clock::now();
  const uint64_t heartbeatA = readFrameSequence(clientA);
  const auto heartbeatMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                               std::chrono::steady_clock::now() - heartbeatStart)
                               .count();
  if ((heartbeatA & kRawFrameHeartbeatSequenceMask) == 0u) {
    fail("heartbeat sequence must use the high-bit namespace");
  }
  if ((heartbeatA & ~kRawFrameHeartbeatSequenceMask) == 0u) {
    fail("heartbeat sequence counter must advance");
  }
  if (heartbeatMs < 800 || heartbeatMs > 1800) {
    fail("heartbeat cadence outside expected window");
  }

  closeSocketHandle(clientA);
  closeSocketHandle(clientB);
  running.store(false);
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = false;
  }
  server.join();

#if defined(_WIN32)
  WSACleanup();
#endif

  std::cout << "raw_frame_server_test passed" << std::endl;
  return 0;
}
