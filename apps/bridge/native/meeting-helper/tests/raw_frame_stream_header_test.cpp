#include "preview/raw_frame_stream_header.h"

#include <iostream>
#include <string>

using broadify::meeting::RawFrameStreamGeometry;
using broadify::meeting::buildRawFrameStreamHeader;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "raw_frame_stream_header_test failed: " << what << std::endl;
  }
  return condition;
}

bool contains(const std::string &haystack, const std::string &needle) {
  return haystack.find(needle) != std::string::npos;
}

}  // namespace

int main() {
  bool ok = true;

  const std::string header = buildRawFrameStreamHeader(RawFrameStreamGeometry{1920, 1080, 30});
  ok &= expect(header.rfind("HTTP/1.1 200 OK\r\n", 0) == 0, "status line first");
  ok &= expect(contains(header, "Content-Type: application/vnd.broadify.raw-bgra-stream\r\n"), "content type kept");
  ok &= expect(contains(header, "Connection: close\r\n"), "connection close kept");
  ok &= expect(contains(header, "X-Broadify-Frame-Width: 1920\r\n"), "width header");
  ok &= expect(contains(header, "X-Broadify-Frame-Height: 1080\r\n"), "height header");
  ok &= expect(contains(header, "X-Broadify-Frame-Fps: 30\r\n"), "fps header");
  // Exactly one blank line, and it terminates the block: the first BFRG record
  // follows immediately after it on the wire.
  const size_t blank = header.find("\r\n\r\n");
  ok &= expect(blank != std::string::npos, "blank line present");
  ok &= expect(blank + 4 == header.size(), "blank line terminates the header");
  ok &= expect(header.find("\r\n\r\n", blank + 1) == std::string::npos, "single blank line");
  ok &= expect(header.find("\n\n") == std::string::npos, "no bare LF pairs");

  const std::string other = buildRawFrameStreamHeader(RawFrameStreamGeometry{1280, 720, 60});
  ok &= expect(contains(other, "X-Broadify-Frame-Width: 1280\r\n"), "width follows geometry");
  ok &= expect(contains(other, "X-Broadify-Frame-Height: 720\r\n"), "height follows geometry");
  ok &= expect(contains(other, "X-Broadify-Frame-Fps: 60\r\n"), "fps follows geometry");

  if (!ok) {
    return 1;
  }
  std::cout << "raw_frame_stream_header_test passed" << std::endl;
  return 0;
}
