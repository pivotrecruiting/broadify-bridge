#include "preview/raw_frame_server.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <streambuf>
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

// Captures std::cout as complete lines while alive. The server logs its JSON
// events from the accept thread and one worker thread per client, each line
// in several insertions, so lines are assembled per writing thread.
class ScopedCoutCapture {
 public:
  ScopedCoutCapture() : previous_(std::cout.rdbuf(&buffer_)) {}
  ~ScopedCoutCapture() { std::cout.rdbuf(previous_); }
  ScopedCoutCapture(const ScopedCoutCapture &) = delete;
  ScopedCoutCapture &operator=(const ScopedCoutCapture &) = delete;

  std::vector<std::string> lines() { return buffer_.lines(); }

 private:
  class LineBuffer : public std::streambuf {
   public:
    std::vector<std::string> lines() {
      std::lock_guard<std::mutex> lock(mutex_);
      return lines_;
    }

   protected:
    int_type overflow(int_type ch) override {
      if (!traits_type::eq_int_type(ch, traits_type::eof())) {
        const char value = traits_type::to_char_type(ch);
        append(&value, 1u);
      }
      return traits_type::not_eof(ch);
    }

    std::streamsize xsputn(const char *data, std::streamsize count) override {
      append(data, static_cast<size_t>(count));
      return count;
    }

   private:
    void append(const char *data, size_t count) {
      std::lock_guard<std::mutex> lock(mutex_);
      std::string &pending = pending_[std::this_thread::get_id()];
      for (size_t i = 0; i < count; ++i) {
        if (data[i] == '\n') {
          lines_.push_back(pending);
          pending.clear();
        } else {
          pending.push_back(data[i]);
        }
      }
    }

    std::mutex mutex_;
    std::map<std::thread::id, std::string> pending_;
    std::vector<std::string> lines_;
  };

  LineBuffer buffer_;
  std::streambuf *previous_;
};

// The "frame_sent" events among captured server log lines.
std::vector<std::string> frameSentEvents(const std::vector<std::string> &lines) {
  std::vector<std::string> events;
  for (const std::string &line : lines) {
    if (line.find("\"event\":\"frame_sent\"") != std::string::npos) {
      events.push_back(line);
    }
  }
  return events;
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

// A portrait program (engine 1080x1920) must reach the 16:9-only virtual
// camera as 1920x1080: handshake headers, record header and payload size stay
// landscape, the program sits pillarboxed between opaque black bars. The
// "frame_sent" event reports the delivered record, not the program size.
void assertPortraitProgramIsPillarboxed() {
  const uint16_t port = reservePort();
  PreviewFrameStore previewFrames;
  MeetingState state;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = true;
  }
  std::atomic<bool> running{true};
  const RawFrameStreamGeometry programGeometry{1080, 1920, 30};
  auto serverLog = std::make_unique<ScopedCoutCapture>();
  std::thread server([&] {
    runRawFrameServer(port, programGeometry, previewFrames, state, running);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  constexpr uint32_t kProgramWidth = 1080u;
  constexpr uint32_t kProgramHeight = 1920u;
  constexpr uint32_t kVcamWidth = 1920u;
  constexpr uint32_t kVcamHeight = 1080u;
  // Solid RGBA (200, 40, 90): arrives as BGRA (90, 40, 200).
  std::vector<uint8_t> rgba(static_cast<size_t>(kProgramWidth) *
                            kProgramHeight * 4u);
  for (size_t offset = 0; offset < rgba.size(); offset += 4u) {
    rgba[offset + 0u] = 200u;
    rgba[offset + 1u] = 40u;
    rgba[offset + 2u] = 90u;
    rgba[offset + 3u] = 255u;
  }
  previewFrames.publish(kProgramWidth, kProgramHeight, rgba.data(),
                        rgba.size());

  for (const bool acceptsV2 : {true, false}) {
    const size_t headerSize =
        acceptsV2 ? kRawFrameHeaderV2Size : kRawFrameHeaderV1Size;
    const int client = connectClient(port, acceptsV2);
    const std::string header = readHttpHeader(client);
    if (header.find("X-Broadify-Frame-Width: 1920\r\n") == std::string::npos ||
        header.find("X-Broadify-Frame-Height: 1080\r\n") ==
            std::string::npos ||
        header.find("X-Broadify-Frame-Fps: 30\r\n") == std::string::npos) {
      fail("portrait program must advertise the 1920x1080 vcam geometry");
    }
    const RawFrameRecord record = readFrameRecord(client, headerSize);
    closeSocketHandle(client);
    if (readU32Le(record.header.data() + 8) != kVcamWidth ||
        readU32Le(record.header.data() + 12) != kVcamHeight) {
      fail("portrait frame record must be 1920x1080");
    }
    if (readU32Le(record.header.data() + 16) != kRawFramePixelFormatBgra8) {
      fail("portrait frame record must stay BGRA8");
    }
    const size_t expectedPayload =
        static_cast<size_t>(kVcamWidth) * kVcamHeight * 4u;
    if (readU32Le(record.header.data() + 20) != expectedPayload ||
        record.payload.size() != expectedPayload) {
      fail("portrait frame payload must be a full 1920x1080 BGRA frame");
    }
    // 1080x1920 contained in 1920x1080: columns 656..1263 carry the program.
    const auto pixel = [&](uint32_t x, uint32_t y) {
      return record.payload.data() +
             (static_cast<size_t>(y) * kVcamWidth + x) * 4u;
    };
    const auto isBlack = [](const uint8_t *p) {
      return p[0] == 0u && p[1] == 0u && p[2] == 0u && p[3] == 255u;
    };
    const auto isProgram = [](const uint8_t *p) {
      const auto close = [](uint8_t value, int expected) {
        return value >= expected - 1 && value <= expected + 1;
      };
      return close(p[0], 90) && close(p[1], 40) && close(p[2], 200) &&
             p[3] >= 254u;
    };
    for (const uint32_t y : {0u, 540u, 1079u}) {
      if (!isBlack(pixel(0u, y)) || !isBlack(pixel(655u, y)) ||
          !isBlack(pixel(1264u, y)) || !isBlack(pixel(1919u, y))) {
        fail("portrait frame bars must be opaque black");
      }
      if (!isProgram(pixel(656u, y)) || !isProgram(pixel(960u, y)) ||
          !isProgram(pixel(1263u, y))) {
        fail("portrait program must sit centered between the bars");
      }
    }
  }

  running.store(false);
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamRawRunning = false;
  }
  server.join();

  const std::vector<std::string> sentEvents =
      frameSentEvents(serverLog->lines());
  serverLog.reset();
  if (sentEvents.size() != 2u) {
    fail("each portrait client must log one frame_sent event");
  }
  for (const std::string &event : sentEvents) {
    if (event.find(",\"width\":1920,\"height\":1080,") == std::string::npos) {
      fail("portrait frame_sent must log the delivered 1920x1080 record");
    }
    if (event.find(",\"source_width\":1080,\"source_height\":1920,") ==
        std::string::npos) {
      fail("portrait frame_sent must log the program size as source_*");
    }
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

  auto serverLog = std::make_unique<ScopedCoutCapture>();
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
  // Landscape/square programs are advertised with their own geometry.
  const std::string landscapeHeader = readHttpHeader(clientA);
  if (landscapeHeader.find("X-Broadify-Frame-Width: 2\r\n") ==
          std::string::npos ||
      landscapeHeader.find("X-Broadify-Frame-Height: 2\r\n") ==
          std::string::npos) {
    fail("landscape program geometry must be advertised unchanged");
  }
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

  // A landscape program is delivered as is: the frame_sent line keeps its
  // former shape (delivered size == program size, no source_* keys).
  const std::vector<std::string> sentEvents =
      frameSentEvents(serverLog->lines());
  serverLog.reset();
  if (sentEvents.size() < 3u) {
    fail("each landscape client must log a frame_sent event");
  }
  for (const std::string &event : sentEvents) {
    if (event !=
        "{\"type\":\"meeting_vcam_raw\",\"event\":\"frame_sent\",\"seq\":1,"
        "\"width\":2,\"height\":2,\"sent_frames\":1}") {
      fail("landscape frame_sent line must stay unchanged");
    }
  }

  assertPortraitProgramIsPillarboxed();

#if defined(_WIN32)
  WSACleanup();
#endif

  std::cout << "raw_frame_server_test passed" << std::endl;
  return 0;
}
