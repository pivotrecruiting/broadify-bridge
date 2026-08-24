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
constexpr uint32_t kRawFrameVersion1 = 1u;
constexpr uint32_t kRawFrameVersion2 = 2u;
constexpr uint32_t kRawFramePixelFormatBgra8 = 2u;
constexpr size_t kRawFrameHeaderV1Size = 32u;
constexpr size_t kRawFrameHeaderV2Size = 40u;
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

void writeU32Le(uint8_t *p, uint32_t value) {
  p[0] = static_cast<uint8_t>(value & 0xffu);
  p[1] = static_cast<uint8_t>((value >> 8u) & 0xffu);
  p[2] = static_cast<uint8_t>((value >> 16u) & 0xffu);
  p[3] = static_cast<uint8_t>((value >> 24u) & 0xffu);
}

void writeU64Le(uint8_t *p, uint64_t value) {
  for (int i = 0; i < 8; i++) {
    p[i] = static_cast<uint8_t>((value >> (8 * i)) & 0xffu);
  }
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

int connectClient(uint16_t port, bool acceptsKeepAliveV2) {
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
  std::string request =
      "GET /stream.rgba HTTP/1.1\r\n"
      "Host: 127.0.0.1\r\n";
  if (acceptsKeepAliveV2) {
    request += "X-Broadify-Accepts: keepalive-v2\r\n";
  }
  request += "Connection: close\r\n\r\n";
  if (send(socketHandle, request.c_str(), static_cast<int>(request.size()), 0) <=
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

struct RawFrameRecord {
  std::vector<uint8_t> header;
  std::vector<uint8_t> payload;
};

RawFrameRecord readFrameRecord(int socketHandle, size_t headerSize) {
  std::vector<uint8_t> header(headerSize);
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
  return RawFrameRecord{header, payload};
}

uint64_t readFrameSequence(int socketHandle, size_t headerSize) {
  const RawFrameRecord record = readFrameRecord(socketHandle, headerSize);
  return readU64Le(record.header.data() + 24);
}

bool recvTimesOut(int socketHandle) {
  uint8_t byte = 0;
  const int result = recv(socketHandle, reinterpret_cast<char *>(&byte), 1, 0);
  return result <= 0;
}

std::vector<uint8_t> buildLegacyV1RecordBytes() {
  std::vector<uint8_t> expected(kRawFrameHeaderV1Size + 16u);
  writeU32Le(expected.data(), kRawFrameMagic);
  writeU32Le(expected.data() + 4u, kRawFrameVersion1);
  writeU32Le(expected.data() + 8u, 2u);
  writeU32Le(expected.data() + 12u, 2u);
  writeU32Le(expected.data() + 16u, kRawFramePixelFormatBgra8);
  writeU32Le(expected.data() + 20u, 16u);
  writeU64Le(expected.data() + 24u, 1u);
  const uint8_t bgra[16] = {
      0, 0, 255, 255, 0, 255, 0, 255,
      255, 0, 0, 255, 255, 255, 255, 255,
  };
  std::memcpy(expected.data() + kRawFrameHeaderV1Size, bgra, sizeof(bgra));
  return expected;
}

void assertDisarmedHandshake(uint16_t port, MeetingState &state) {
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = false;
  }
  const int client = connectClient(port, true);
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

  const int legacyEmptyClient = connectClient(port, false);
  (void)readHttpHeader(legacyEmptyClient);
  if (!recvTimesOut(legacyEmptyClient)) {
    fail("legacy v1 clients must not receive zero-length keep-alives");
  }
  closeSocketHandle(legacyEmptyClient);

  const int emptyClient = connectClient(port, true);
  (void)readHttpHeader(emptyClient);
  const RawFrameRecord emptyHeartbeatRecord =
      readFrameRecord(emptyClient, kRawFrameHeaderV2Size);
  if (readU32Le(emptyHeartbeatRecord.header.data() + 4) != kRawFrameVersion2) {
    fail("v2 client must receive version 2 records");
  }
  if (emptyHeartbeatRecord.header.size() != kRawFrameHeaderV2Size) {
    fail("v2 header must be 40 bytes");
  }
  if (readU32Le(emptyHeartbeatRecord.header.data() + 20) != 0u) {
    fail("v2 empty heartbeat must have zero payload");
  }
  const uint64_t emptyHeartbeat =
      readU64Le(emptyHeartbeatRecord.header.data() + 24);
  if ((emptyHeartbeat & kRawFrameHeartbeatSequenceMask) == 0u) {
    fail("empty stream heartbeat sequence must use the high-bit namespace");
  }
  closeSocketHandle(emptyClient);

  const uint8_t rgba[16] = {
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
  };
  previewFrames.publish(2, 2, rgba, sizeof(rgba));

  const int clientA = connectClient(port, true);
  const int clientB = connectClient(port, true);
  const int legacyClient = connectClient(port, false);
  (void)readHttpHeader(clientA);
  (void)readHttpHeader(clientB);
  (void)readHttpHeader(legacyClient);

  const uint64_t firstA = readFrameSequence(clientA, kRawFrameHeaderV2Size);
  const uint64_t firstB = readFrameSequence(clientB, kRawFrameHeaderV2Size);
  if (firstA == 0 || firstB == 0) {
    fail("both clients must receive an initial frame");
  }
  const RawFrameRecord firstLegacy =
      readFrameRecord(legacyClient, kRawFrameHeaderV1Size);
  if (readU32Le(firstLegacy.header.data() + 4) != kRawFrameVersion1) {
    fail("legacy client must receive version 1 records");
  }
  if (firstLegacy.header.size() != kRawFrameHeaderV1Size) {
    fail("v1 header must be 32 bytes");
  }
  std::vector<uint8_t> firstLegacyBytes = firstLegacy.header;
  firstLegacyBytes.insert(firstLegacyBytes.end(), firstLegacy.payload.begin(),
                          firstLegacy.payload.end());
  if (firstLegacyBytes != buildLegacyV1RecordBytes()) {
    fail("v1 record bytes must match the v0.23.5 writer layout");
  }

  const auto heartbeatStart = std::chrono::steady_clock::now();
  const uint64_t heartbeatA = readFrameSequence(clientA, kRawFrameHeaderV2Size);
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
  const RawFrameRecord legacyHeartbeat =
      readFrameRecord(legacyClient, kRawFrameHeaderV1Size);
  if (readU32Le(legacyHeartbeat.header.data() + 20) != 16u) {
    fail("legacy v1 heartbeat must resend the full frame payload");
  }
  if (legacyHeartbeat.payload.empty()) {
    fail("legacy v1 heartbeat must not be zero-length");
  }

  closeSocketHandle(clientA);
  closeSocketHandle(clientB);
  closeSocketHandle(legacyClient);
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
