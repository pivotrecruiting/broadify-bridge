#include "preview/mjpeg_server.h"

#include "preview/preview_frame_store.h"

#include <chrono>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#endif

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

const unsigned char kTinyJpeg[] = {
    0xff,0xd8,0xff,0xdb,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,0x07,0x07,
    0x07,0x09,0x09,0x08,0x0a,0x0c,0x14,0x0d,0x0c,0x0b,0x0b,0x0c,0x19,0x12,0x13,0x0f,
    0x14,0x1d,0x1a,0x1f,0x1e,0x1d,0x1a,0x1c,0x1c,0x20,0x24,0x2e,0x27,0x20,0x22,0x2c,
    0x23,0x1c,0x1c,0x28,0x37,0x29,0x2c,0x30,0x31,0x34,0x34,0x34,0x1f,0x27,0x39,0x3d,
    0x38,0x32,0x3c,0x2e,0x33,0x34,0x32,0xff,0xc0,0x00,0x0b,0x08,0x00,0x01,0x00,0x01,
    0x01,0x01,0x11,0x00,0xff,0xc4,0x00,0x14,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x08,0xff,0xc4,0x00,0x14,0x10,0x01,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    0xff,0xda,0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0x2a,0xff,0xd9
};

#if defined(__APPLE__)
void releaseData(void *, const void *, size_t) {}

std::vector<uint8_t> mirroredRgba(const PreviewFrame &frame) {
  std::vector<uint8_t> mirrored(frame.rgba.size());
  const size_t rowStride = static_cast<size_t>(frame.width) * 4u;
  for (uint32_t y = 0; y < frame.height; ++y) {
    const size_t rowOffset = static_cast<size_t>(y) * rowStride;
    for (uint32_t x = 0; x < frame.width; ++x) {
      const size_t srcOffset = rowOffset + static_cast<size_t>(x) * 4u;
      const size_t dstOffset = rowOffset + static_cast<size_t>(frame.width - 1u - x) * 4u;
      mirrored[dstOffset + 0u] = frame.rgba[srcOffset + 0u];
      mirrored[dstOffset + 1u] = frame.rgba[srcOffset + 1u];
      mirrored[dstOffset + 2u] = frame.rgba[srcOffset + 2u];
      mirrored[dstOffset + 3u] = frame.rgba[srcOffset + 3u];
    }
  }
  return mirrored;
}

std::vector<uint8_t> encodeJpeg(const PreviewFrame &frame) {
  if (frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
    return std::vector<uint8_t>(std::begin(kTinyJpeg), std::end(kTinyJpeg));
  }

  const std::vector<uint8_t> previewRgba = mirroredRgba(frame);
  CGDataProviderRef provider = CGDataProviderCreateWithData(
      nullptr, previewRgba.data(), previewRgba.size(), releaseData);
  if (provider == nullptr) {
    return std::vector<uint8_t>(std::begin(kTinyJpeg), std::end(kTinyJpeg));
  }

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGImageRef image = CGImageCreate(
      frame.width,
      frame.height,
      8,
      32,
      static_cast<size_t>(frame.width) * 4u,
      colorSpace,
      kCGImageAlphaLast | kCGBitmapByteOrder32Big,
      provider,
      nullptr,
      false,
      kCGRenderingIntentDefault);

  CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
  CGImageDestinationRef destination = data == nullptr
      ? nullptr
      : CGImageDestinationCreateWithData(data, CFSTR("public.jpeg"), 1, nullptr);
  if (destination != nullptr && image != nullptr) {
    const float qualityValue = 0.78f;
    CFNumberRef quality = CFNumberCreate(kCFAllocatorDefault, kCFNumberFloatType, &qualityValue);
    const void *keys[] = {kCGImageDestinationLossyCompressionQuality};
    const void *values[] = {quality};
    CFDictionaryRef properties = CFDictionaryCreate(
        kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CGImageDestinationAddImage(destination, image, properties);
    CGImageDestinationFinalize(destination);
    if (properties != nullptr) {
      CFRelease(properties);
    }
    if (quality != nullptr) {
      CFRelease(quality);
    }
  }

  std::vector<uint8_t> jpeg;
  if (data != nullptr) {
    const UInt8 *bytes = CFDataGetBytePtr(data);
    const CFIndex length = CFDataGetLength(data);
    if (bytes != nullptr && length > 0) {
      jpeg.assign(bytes, bytes + length);
    }
  }

  if (destination != nullptr) {
    CFRelease(destination);
  }
  if (data != nullptr) {
    CFRelease(data);
  }
  if (image != nullptr) {
    CGImageRelease(image);
  }
  if (colorSpace != nullptr) {
    CGColorSpaceRelease(colorSpace);
  }
  CGDataProviderRelease(provider);

  if (jpeg.empty()) {
    return std::vector<uint8_t>(std::begin(kTinyJpeg), std::end(kTinyJpeg));
  }
  return jpeg;
}
#else
std::vector<uint8_t> encodeJpeg(const PreviewFrame &) {
  return std::vector<uint8_t>(std::begin(kTinyJpeg), std::end(kTinyJpeg));
}
#endif

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

bool sendString(int socketHandle, const std::string &data) {
  return sendAll(socketHandle, data.c_str(), data.size());
}

}  // namespace

void runMjpegServer(uint16_t port, PreviewFrameStore &previewFrames, std::atomic<bool> &running) {
#if defined(_WIN32)
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
  int serverFd = static_cast<int>(socket(AF_INET, SOCK_STREAM, 0));
  if (serverFd < 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"preview_socket_failed\",\"message\":\"Could not create preview socket.\"}" << std::endl;
    return;
  }
  int opt = 1;
  setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char *>(&opt), sizeof(opt));
  configureSocketForShutdownChecks(serverFd);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(port);
  if (bind(serverFd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(serverFd, 8) != 0) {
    std::cout << "{\"type\":\"error\",\"code\":\"preview_bind_failed\",\"message\":\"Could not bind preview port.\"}" << std::endl;
    closeSocketHandle(serverFd);
    return;
  }

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
    const std::string header =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
        "Cache-Control: no-store\r\n\r\n";
    if (!sendString(client, header)) {
      closeSocketHandle(client);
      continue;
    }

    std::vector<uint8_t> lastValidJpeg(std::begin(kTinyJpeg), std::end(kTinyJpeg));
    while (running.load()) {
      PreviewFrame frame;
      if (previewFrames.copyLatest(frame)) {
        lastValidJpeg = encodeJpeg(frame);
      }
      std::ostringstream part;
      part << "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " << lastValidJpeg.size() << "\r\n\r\n";
      const std::string partHeader = part.str();
      if (!sendString(client, partHeader) ||
          !sendAll(client, reinterpret_cast<const char *>(lastValidJpeg.data()), lastValidJpeg.size()) ||
          !sendAll(client, "\r\n", 2)) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(33));
    }
    closeSocketHandle(client);
  }
  closeSocketHandle(serverFd);
#if defined(_WIN32)
  WSACleanup();
#endif
}

}  // namespace broadify::meeting
