#include "preview/raw_frame_stream_header.h"

namespace broadify::meeting {

std::string buildRawFrameStreamHeader(const RawFrameStreamGeometry &geometry) {
  std::string header =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/vnd.broadify.raw-bgra-stream\r\n"
      "Cache-Control: no-store\r\n"
      "Connection: close\r\n";
  header += "X-Broadify-Frame-Width: " + std::to_string(geometry.width) + "\r\n";
  header += "X-Broadify-Frame-Height: " + std::to_string(geometry.height) + "\r\n";
  header += "X-Broadify-Frame-Fps: " + std::to_string(geometry.fps) + "\r\n";
  header += "\r\n";
  return header;
}

}  // namespace broadify::meeting
