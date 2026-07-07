#include "preview/mjpeg_server.h"

#include "preview/preview_frame_store.h"
#include "state/meeting_state.h"

#include <algorithm>
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

#if !defined(__APPLE__)
// Windows/Linux JPEG encoder for the MJPEG preview (macOS uses ImageIO below).
// The implementation is compiled into this single translation unit.
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "stb_image_write.h"
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

std::vector<uint8_t> encodeJpeg(const PreviewFrame &frame) {
  if (frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
    return std::vector<uint8_t>(std::begin(kTinyJpeg), std::end(kTinyJpeg));
  }

  CGDataProviderRef provider = CGDataProviderCreateWithData(
      nullptr, frame.rgba.data(), frame.rgba.size(), releaseData);
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
    // Preview-only stream: 0.7 is visually near-indistinguishable in the
    // builder preview but substantially cheaper to encode than 0.95.
    const float qualityValue = 0.7f;
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
// stb_image_write memory sink: append encoded bytes to the target vector.
void appendJpegBytes(void *context, void *data, int size) {
  auto *out = static_cast<std::vector<uint8_t> *>(context);
  const auto *bytes = static_cast<const uint8_t *>(data);
  out->insert(out->end(), bytes, bytes + size);
}

std::vector<uint8_t> encodeJpeg(const PreviewFrame &frame) {
  if (frame.rgba.empty() || frame.width == 0u || frame.height == 0u) {
    return std::vector<uint8_t>(std::begin(kTinyJpeg), std::end(kTinyJpeg));
  }
  // JPEG is 3-channel: drop the alpha (RGBA -> RGB) into a scratch buffer.
  const size_t pixels = static_cast<size_t>(frame.width) * frame.height;
  std::vector<uint8_t> rgb(pixels * 3u);
  for (size_t i = 0; i < pixels; ++i) {
    rgb[i * 3u + 0u] = frame.rgba[i * 4u + 0u];
    rgb[i * 3u + 1u] = frame.rgba[i * 4u + 1u];
    rgb[i * 3u + 2u] = frame.rgba[i * 4u + 2u];
  }
  std::vector<uint8_t> jpeg;
  const auto encodeStart = std::chrono::steady_clock::now();
  // Quality 70 matches the macOS ImageIO path (deliberate preview-only choice).
  const int ok = stbi_write_jpg_to_func(
      appendJpegBytes, &jpeg,
      static_cast<int>(frame.width), static_cast<int>(frame.height), 3,
      rgb.data(), 70);
  const double encodeMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - encodeStart).count();
  static bool logged = false;
  if (!logged) {
    logged = true;
    std::cout << "{\"type\":\"preview_encode\",\"width\":" << frame.width
              << ",\"height\":" << frame.height
              << ",\"encode_ms\":" << encodeMs << "}" << std::endl;
  }
  if (ok == 0 || jpeg.empty()) {
    return std::vector<uint8_t>(std::begin(kTinyJpeg), std::end(kTinyJpeg));
  }
  return jpeg;
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

class PreviewClientCounter {
 public:
  explicit PreviewClientCounter(MeetingState &state) : state_(state) {
    std::lock_guard<std::mutex> lock(state_.mutex);
    ++state_.previewClientCount;
    state_.programDirty = true;
    ++state_.programRevision;
  }

  ~PreviewClientCounter() {
    std::lock_guard<std::mutex> lock(state_.mutex);
    state_.previewClientCount = std::max(0, state_.previewClientCount - 1);
    state_.programDirty = true;
    ++state_.programRevision;
  }

 private:
  MeetingState &state_;
};

}  // namespace

void runMjpegServer(uint16_t port,
                    PreviewFrameStore &previewFrames,
                    MeetingState &state,
                    std::atomic<bool> &running) {
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

    PreviewClientCounter clientCounter(state);
    std::vector<uint8_t> lastValidJpeg(std::begin(kTinyJpeg), std::end(kTinyJpeg));
    uint64_t lastSequence = 0u;
    while (running.load()) {
      PreviewFrame frame;
      if (previewFrames.copyLatestIfNew(lastSequence, frame)) {
        lastSequence = frame.sequence;
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
      // ~15fps: the builder preview does not need program frame rate, and
      // JPEG encoding is one of the most expensive per-client costs.
      std::this_thread::sleep_for(std::chrono::milliseconds(66));
    }
    closeSocketHandle(client);
  }
  closeSocketHandle(serverFd);
#if defined(_WIN32)
  WSACleanup();
#endif
}

}  // namespace broadify::meeting
