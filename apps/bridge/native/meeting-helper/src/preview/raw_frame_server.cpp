#include "preview/raw_frame_server.h"

#include <chrono>
#include <cstring>
#include <iostream>
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
constexpr uint32_t kRawFramePixelFormatRgba8 = 1u;
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

std::vector<uint8_t> rawFramePayload(const PreviewFrame &frame) {
  std::vector<uint8_t> payload(kRawFrameHeaderSize + frame.rgba.size());
  writeU32Le(payload, 0u, kRawFrameMagic);
  writeU32Le(payload, 4u, kRawFrameVersion);
  writeU32Le(payload, 8u, frame.width);
  writeU32Le(payload, 12u, frame.height);
  writeU32Le(payload, 16u, kRawFramePixelFormatRgba8);
  writeU32Le(payload, 20u, static_cast<uint32_t>(frame.rgba.size()));
  writeU64Le(payload, 24u, frame.sequence);
  std::memcpy(payload.data() + kRawFrameHeaderSize, frame.rgba.data(), frame.rgba.size());
  return payload;
}

void streamFrames(int client, PreviewFrameStore &previewFrames, std::atomic<bool> &running) {
  const std::string header =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/vnd.broadify.raw-rgba-stream\r\n"
      "Cache-Control: no-store\r\n"
      "Connection: close\r\n\r\n";
  if (!sendAll(client, header.c_str(), header.size())) {
    return;
  }

  uint64_t lastSequence = 0u;
  while (running.load()) {
    PreviewFrame frame;
    if (!previewFrames.copyLatest(frame) || frame.sequence == lastSequence) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      continue;
    }
    lastSequence = frame.sequence;
    const std::vector<uint8_t> payload = rawFramePayload(frame);
    if (!sendAll(client, reinterpret_cast<const char *>(payload.data()), payload.size())) {
      return;
    }
  }
}

}  // namespace

void runRawFrameServer(uint16_t port, PreviewFrameStore &previewFrames, std::atomic<bool> &running) {
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
      streamFrames(client, previewFrames, running);
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
