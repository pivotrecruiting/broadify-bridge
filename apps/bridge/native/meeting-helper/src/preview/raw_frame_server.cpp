#include "preview/raw_frame_server.h"

#include <algorithm>
#include <chrono>
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

namespace broadify::meeting {
namespace {

constexpr uint32_t kRawFrameMagic = 0x47524642u;  // "BFRG" little endian.
constexpr uint32_t kRawFrameVersion = 1u;
constexpr uint32_t kRawFramePixelFormatBgra8 = 2u;
constexpr size_t kRawFrameHeaderSize = 32u;

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
#if defined(SO_NOSIGPIPE)
  int opt = 1;
  setsockopt(socketHandle, SOL_SOCKET, SO_NOSIGPIPE, reinterpret_cast<const char *>(&opt), sizeof(opt));
#else
  (void)socketHandle;
#endif
}

int sendFlags() {
#if defined(MSG_NOSIGNAL)
  return MSG_NOSIGNAL;
#else
  return 0;
#endif
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

void streamFrames(int client, PreviewFrameStore &previewFrames, MeetingState &state, std::atomic<bool> &running) {
  const std::string header =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/vnd.broadify.raw-bgra-stream\r\n"
      "Cache-Control: no-store\r\n"
      "Connection: close\r\n\r\n";
  if (!sendAll(client, header.c_str(), header.size())) {
    return;
  }

  uint64_t lastSequence = 0u;
  uint64_t sentFrames = 0u;
  std::vector<uint8_t> payload;
  VcamClientCounter clientCounter(state);
  while (running.load()) {
    if (!isVcamRawRunning(state)) {
      return;
    }
    PreviewFrame frame;
    if (!previewFrames.copyLatestIfNew(lastSequence, frame)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(16));
      continue;
    }
    lastSequence = frame.sequence;
    writeRawFramePayload(frame, payload);
    if (!sendAll(client, reinterpret_cast<const char *>(payload.data()), payload.size())) {
      return;
    }
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

}  // namespace

void runRawFrameServer(uint16_t port,
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
  setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char *>(&opt), sizeof(opt));
  configureSocketForShutdownChecks(serverFd);

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(port);
  if (bind(serverFd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(serverFd, 16) != 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"vcam_raw_bind_failed\",\"port\":" << port
              << ",\"message\":\"Could not bind VCam raw frame port.\"}" << std::endl;
    closeSocketHandle(serverFd);
    return;
  }

  std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"listening\",\"port\":" << port << "}" << std::endl;

  while (running.load()) {
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

    configureClientSocket(client);
    const std::string request = readRequest(client);
    if (request.find("GET /stream.rgba ") != std::string::npos) {
      std::cout << "{\"type\":\"meeting_vcam_raw\",\"event\":\"client_connected\",\"port\":" << port << "}" << std::endl;
      streamFrames(client, previewFrames, state, running);
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

  closeSocketHandle(serverFd);
#if defined(_WIN32)
  WSACleanup();
#endif
}

}  // namespace broadify::meeting
