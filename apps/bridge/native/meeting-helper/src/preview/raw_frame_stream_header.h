#pragma once

#include <cstdint>
#include <string>

namespace broadify::meeting {

/** Program geometry advertised to raw-frame stream clients in the HTTP handshake. */
struct RawFrameStreamGeometry {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 0;
};

/**
 * Builds the HTTP response header block (terminated by the blank line) sent
 * before the first BFRG record. The geometry travels in
 * `X-Broadify-Frame-Width/-Height/-Fps` so the Windows virtual-camera DLL can
 * fix its media type without waiting for a frame; readers that ignore headers
 * (macOS CMIO extension) still only look for `200 OK` and the blank line.
 * Stdlib-only so it is unit-testable without sockets.
 */
std::string buildRawFrameStreamHeader(const RawFrameStreamGeometry &geometry);

}  // namespace broadify::meeting
