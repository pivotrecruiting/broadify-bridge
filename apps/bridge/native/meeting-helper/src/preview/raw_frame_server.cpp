#include "preview/raw_frame_server.h"

#include "util/helper_event_log.h"
#include "util/win_qos.h"

#if defined(__APPLE__)
#include <Accelerate/Accelerate.h>
#endif

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace broadify::meeting {
namespace {

constexpr uint32_t kRawFrameMagic = 0x47524642u;  // "BFRG" little endian.
constexpr uint32_t kRawFrameVersion = 1u;
constexpr uint32_t kRawFramePixelFormatBgra8 = 2u;
constexpr size_t kRawFrameHeaderSize = 32u;
constexpr auto kRawFrameHeartbeatInterval = std::chrono::milliseconds(1000);
constexpr uint64_t kRawFrameHeartbeatSequenceMask = 1ull << 63;

void closeSocketHandle(int socketHandle) {
#if defined(_WIN32)
  closesocket(socketHandle);
#else
  close(socketHandle);
#endif
}

void configureSocketForShutdownChecks(int socketHandle) {
#if defined(_WIN32)
  const int timeoutMs = 250;
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&timeoutMs), sizeof(timeoutMs));
#else
  timeval timeout{};
  timeout.tv_sec = 0;
  timeout.tv_usec = 250000;
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&timeout), sizeof(timeout));
#endif
}

void configureClientSocket(int socketHandle) {
  const int opt = 1;
#if defined(SO_NOSIGPIPE)
  setsockopt(socketHandle, SOL_SOCKET, SO_NOSIGPIPE, reinterpret_cast<const char *>(&opt), sizeof(opt));
#endif
  setsockopt(socketHandle, IPPROTO_TCP, TCP_NODELAY,
             reinterpret_cast<const char *>(&opt), sizeof(opt));
#if defined(_WIN32)
  const int sendTimeoutMs = 2000;
  const int receiveTimeoutMs = 5000;
  setsockopt(socketHandle, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char *>(&sendTimeoutMs), sizeof(sendTimeoutMs));
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&receiveTimeoutMs), sizeof(receiveTimeoutMs));
#else
  timeval sendTimeout{};
  sendTimeout.tv_sec = 2;
  sendTimeout.tv_usec = 0;
  setsockopt(socketHandle, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char *>(&sendTimeout), sizeof(sendTimeout));
  timeval receiveTimeout{};
  receiveTimeout.tv_sec = 5;
  receiveTimeout.tv_usec = 0;
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&receiveTimeout), sizeof(receiveTimeout));
#endif
  (void)opt;
}

void configureSenderBuffer(int socketHandle, const RawFrameStreamGeometry &geometry) {
  const int minimumBytes = static_cast<int>(
      std::max<size_t>(64 * 1024u,
                       static_cast<size_t>(geometry.width) * geometry.height * 4u * 2u));
  setsockopt(socketHandle, SOL_SOCKET, SO_SNDBUF,
             reinterpret_cast<const char *>(&minimumBytes), sizeof(minimumBytes));
}

int sendFlags() {
#if defined(MSG_NOSIGNAL)
  return MSG_NOSIGNAL;
#else
  return 0;
#endif
}

int lastSocketError() {
#if defined(_WIN32)
  return WSAGetLastError();
#else
  return errno;
#endif
}

void logRawSocketError(const char *operation, int errorCode) {
  std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"error\",\"operation\":\"" << operation
            << "\",\"error_code\":" << errorCode << "}" << std::endl;
}

bool sendAll(int socketHandle, const char *data, size_t size) {
  size_t bytesSent = 0;
  while (bytesSent < size) {
    const int result = send(
        socketHandle,
        data + bytesSent,
        static_cast<int>(size - bytesSent),
        sendFlags());
    if (result <= 0) {
      logRawSocketError("send", lastSocketError());
      return false;
    }
    bytesSent += static_cast<size_t>(result);
  }
  return true;
}

std::string readRequest(int socketHandle) {
  char buffer[1024];
  const int result = recv(socketHandle, buffer, static_cast<int>(sizeof(buffer) - 1u), 0);
  if (result <= 0) {
    return {};
  }
  buffer[result] = '\0';
  return std::string(buffer);
}

bool peerClosed(int socketHandle) {
  fd_set readSet;
  FD_ZERO(&readSet);
  FD_SET(socketHandle, &readSet);
  timeval timeout{};
  const int ready = select(socketHandle + 1, &readSet, nullptr, nullptr, &timeout);
  if (ready == 0) {
    return false;
  }
  if (ready < 0) {
    logRawSocketError("peer_select", lastSocketError());
    return true;
  }
  char byte = 0;
  const int result = recv(socketHandle, &byte, 1, MSG_PEEK);
  if (result == 0) {
    return true;
  }
  if (result < 0) {
    logRawSocketError("peer_peek", lastSocketError());
    return true;
  }
  return false;
}

void writeU32Le(std::vector<uint8_t> &data, size_t offset, uint32_t value) {
  data[offset + 0u] = static_cast<uint8_t>(value & 0xffu);
  data[offset + 1u] = static_cast<uint8_t>((value >> 8u) & 0xffu);
  data[offset + 2u] = static_cast<uint8_t>((value >> 16u) & 0xffu);
  data[offset + 3u] = static_cast<uint8_t>((value >> 24u) & 0xffu);
}

void writeU64Le(std::vector<uint8_t> &data, size_t offset, uint64_t value) {
  for (size_t i = 0; i < 8u; ++i) {
    data[offset + i] = static_cast<uint8_t>((value >> (i * 8u)) & 0xffu);
  }
}

void writeRawFramePayload(const PreviewFrame &frame, std::vector<uint8_t> &payload) {
  payload.resize(kRawFrameHeaderSize + frame.rgba.size());
  writeU32Le(payload, 0u, kRawFrameMagic);
  writeU32Le(payload, 4u, kRawFrameVersion);
  writeU32Le(payload, 8u, frame.width);
  writeU32Le(payload, 12u, frame.height);
  writeU32Le(payload, 16u, kRawFramePixelFormatBgra8);
  writeU32Le(payload, 20u, static_cast<uint32_t>(frame.rgba.size()));
  writeU64Le(payload, 24u, frame.sequence);

  uint8_t *dst = payload.data() + kRawFrameHeaderSize;
  const uint8_t *src = frame.rgba.data();
#if defined(__APPLE__)
  // SIMD-accelerated RGBA->BGRA swizzle; the scalar loop cost several
  // milliseconds per frame per virtual-camera client.
  vImage_Buffer sourceBuffer;
  sourceBuffer.data = const_cast<uint8_t *>(src);
  sourceBuffer.height = frame.height;
  sourceBuffer.width = frame.width;
  sourceBuffer.rowBytes = static_cast<size_t>(frame.width) * 4u;
  vImage_Buffer destinationBuffer;
  destinationBuffer.data = dst;
  destinationBuffer.height = frame.height;
  destinationBuffer.width = frame.width;
  destinationBuffer.rowBytes = static_cast<size_t>(frame.width) * 4u;
  const uint8_t kRgbaToBgra[4] = {2, 1, 0, 3};
  if (vImagePermuteChannels_ARGB8888(&sourceBuffer, &destinationBuffer, kRgbaToBgra, kvImageNoFlags) == kvImageNoError) {
    return;
  }
#endif
  const size_t pixelCount = frame.rgba.size() / 4u;
  for (size_t pixel = 0u; pixel < pixelCount; ++pixel) {
    const size_t offset = pixel * 4u;
    dst[offset + 0u] = src[offset + 2u];
    dst[offset + 1u] = src[offset + 1u];
    dst[offset + 2u] = src[offset + 0u];
    dst[offset + 3u] = src[offset + 3u];
  }
}

bool isVcamRawRunning(MeetingState &state) {
  std::lock_guard<std::mutex> lock(state.mutex);
  return state.vcamRawRunning;
}

class VcamClientCounter {
 public:
  explicit VcamClientCounter(MeetingState &state) : state_(state) {
    std::lock_guard<std::mutex> lock(state_.mutex);
    ++state_.vcamClientCount;
    state_.programDirty = true;
    ++state_.programRevision;
  }

  ~VcamClientCounter() {
    std::lock_guard<std::mutex> lock(state_.mutex);
    state_.vcamClientCount = std::max(0, state_.vcamClientCount - 1);
    state_.programDirty = true;
    ++state_.programRevision;
  }

 private:
  MeetingState &state_;
};

void streamFrames(int client,
                  const RawFrameStreamGeometry &geometry,
                  PreviewFrameStore &previewFrames,
                  MeetingState &state,
                  std::atomic<bool> &running) {
  ScopedWinMmcss senderThreadQos(L"Capture");
  configureSenderBuffer(client, geometry);
  const std::string header = buildRawFrameStreamHeader(geometry);
  if (!sendAll(client, header.c_str(), header.size())) {
    return;
  }

  // Keep a clear TCP boundary between the HTTP response headers and the first
  // raw frame header. The macOS CMIO extension reader validates the next bytes
  // after the HTTP handshake as the BFRG frame header; without a small pause,
  // header and frame bytes may be coalesced and the extension can lose the
  // first frame header while parsing HTTP.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));

  uint64_t lastSequence = 0u;
  uint64_t heartbeatSequence = 0u;
  uint64_t sentFrames = 0u;
  std::vector<uint8_t> payload;
  auto lastSentAt = std::chrono::steady_clock::now();
  VcamClientCounter clientCounter(state);
  while (running.load()) {
    if (!isVcamRawRunning(state)) {
      return;
    }
    if (peerClosed(client)) {
      return;
    }
    PreviewFrame frame;
    if (!previewFrames.copyLatestIfNew(lastSequence, frame)) {
      const auto now = std::chrono::steady_clock::now();
      if (!payload.empty() && now - lastSentAt >= kRawFrameHeartbeatInterval) {
        ++heartbeatSequence;
        writeU64Le(payload, 24u,
                   kRawFrameHeartbeatSequenceMask | heartbeatSequence);
        if (!sendAll(client, reinterpret_cast<const char *>(payload.data()), payload.size())) {
          return;
        }
        lastSentAt = now;
      }
      previewFrames.waitForNewFrame(lastSequence,
                                    std::chrono::steady_clock::now() +
                                        kRawFrameHeartbeatInterval);
      continue;
    }
    lastSequence = frame.sequence;
    heartbeatSequence = frame.sequence;
    writeRawFramePayload(frame, payload);
    if (!sendAll(client, reinterpret_cast<const char *>(payload.data()), payload.size())) {
      return;
    }
    lastSentAt = std::chrono::steady_clock::now();
    ++sentFrames;
    if (sentFrames == 1u || sentFrames % 90u == 0u) {
      std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"frame_sent\",\"seq\":" << frame.sequence
                << ",\"width\":" << frame.width
                << ",\"height\":" << frame.height
                << ",\"sent_frames\":" << sentFrames
                << "}" << std::endl;
    }
  }
}

void handleClient(int client,
                  uint16_t port,
                  RawFrameStreamGeometry geometry,
                  PreviewFrameStore &previewFrames,
                  MeetingState &state,
                  std::atomic<bool> &running) {
  configureClientSocket(client);
  const std::string request = readRequest(client);
  if (request.find("GET /stream.rgba ") != std::string::npos) {
    std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"client_connected\",\"port\":" << port << "}" << std::endl;
    streamFrames(client, geometry, previewFrames, state, running);
    std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"client_disconnected\",\"port\":" << port << "}" << std::endl;
  } else {
    const std::string response =
        "HTTP/1.1 404 Not Found\r\n"
        "Content-Length: 0\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n";
    (void)sendAll(client, response.c_str(), response.size());
  }
  closeSocketHandle(client);
}

}  // namespace

void runRawFrameServer(uint16_t port,
                       RawFrameStreamGeometry geometry,
                       PreviewFrameStore &previewFrames,
                       MeetingState &state,
                       std::atomic<bool> &running) {
#if defined(_WIN32)
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

  int serverFd = static_cast<int>(socket(AF_INET, SOCK_STREAM, 0));
  if (serverFd < 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"vcam_raw_socket_failed\",\"message\":\"Could not create VCam raw frame socket.\"}" << std::endl;
    return;
  }

  int opt = 1;
#if defined(_WIN32)
  setsockopt(serverFd, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char *>(&opt), sizeof(opt));
#else
  setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char *>(&opt), sizeof(opt));
#endif
  configureSocketForShutdownChecks(serverFd);

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(port);
  if (bind(serverFd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(serverFd, 16) != 0) {
    const int errorCode = lastSocketError();
    logRawSocketError("bind_listen", errorCode);
    emitHelperEvent("{\"type\":\"error\",\"code\":\"vcam_raw_bind_failed\",\"port\":" + std::to_string(port) +
                    ",\"message\":\"Could not bind VCam raw frame port.\"}");
    emitHelperEvent("{\"type\":\"meeting_vcam_raw\",\"event\":\"error\",\"code\":\"vcam_raw_bind_failed\",\"port\":" + std::to_string(port) +
                    ",\"error_code\":" + std::to_string(errorCode) + "}");
    closeSocketHandle(serverFd);
    return;
  }

  std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"listening\",\"port\":" << port << "}" << std::endl;

  std::vector<std::thread> workers;
  while (running.load()) {
    fd_set readSet;
    FD_ZERO(&readSet);
    FD_SET(serverFd, &readSet);
    timeval acceptTimeout{};
    acceptTimeout.tv_sec = 0;
    acceptTimeout.tv_usec = 250000;
    const int ready =
        select(serverFd + 1, &readSet, nullptr, nullptr, &acceptTimeout);
    if (ready == 0) {
      continue;
    }
    if (ready < 0) {
      logRawSocketError("accept_select", lastSocketError());
      continue;
    }
    sockaddr_in clientAddr{};
#if defined(_WIN32)
    int len = sizeof(clientAddr);
    int client = static_cast<int>(accept(serverFd, reinterpret_cast<sockaddr *>(&clientAddr), &len));
#else
    socklen_t len = sizeof(clientAddr);
    int client = accept(serverFd, reinterpret_cast<sockaddr *>(&clientAddr), &len);
#endif
    if (client < 0) {
      continue;
    }

    workers.emplace_back(handleClient, client, port, geometry, std::ref(previewFrames), std::ref(state), std::ref(running));
  }

  closeSocketHandle(serverFd);
  for (std::thread &worker : workers) {
    if (worker.joinable()) {
      worker.join();
    }
  }
#if defined(_WIN32)
  WSACleanup();
#endif
}

}  // namespace broadify::meeting
