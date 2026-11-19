#pragma once

#include <cstdint>
#include <vector>

namespace broadify::pgm {

/** Pixel layouts the Windows UVC backend can hand to the encoder path. */
enum class UvcSubtype { Nv12, Yuy2, Uyvy, Mjpg, Other };

/** One native mode a UVC device announces (Media Foundation native media type). */
struct UvcFormatCandidate {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fpsNum = 0;
  uint32_t fpsDen = 0;
  UvcSubtype subtype = UvcSubtype::Other;
};

/** Modes above this line count are never selected (same limit as the macOS backend). */
constexpr uint32_t kUvcMaxLines = 1080;

/**
 * Picks the device mode: largest geometry up to 1080 lines, then the highest
 * frame rate, then the subtype NV12 > YUY2 > UYVY > MJPG, so MJPG is only
 * chosen when the highest mode is not offered uncompressed. Ties keep the
 * device's own order. `allowMjpg` false leaves MJPG modes out (no decoder).
 * Returns the index into `candidates`, or -1 when no mode is usable.
 */
int selectUvcFormat(const std::vector<UvcFormatCandidate> &candidates, bool allowMjpg = true);

/** "nv12" | "yuy2" | "uyvy" | "mjpg" | "other". */
const char *uvcSubtypeName(UvcSubtype subtype);

/**
 * Error code for a failed open or a failed first read, from the HRESULT. Same
 * codes as the macOS backend: `camera_permission_denied` (privacy gate),
 * `unsupported_format` (no media type could be negotiated), and
 * `device_in_use` for everything else, since a camera another application
 * holds is by far the usual reason a device that enumerates cannot start.
 */
const char *uvcOpenErrorCode(uint32_t hresult);

}  // namespace broadify::pgm
