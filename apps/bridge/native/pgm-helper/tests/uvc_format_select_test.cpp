// Mode selection of the Windows UVC backend: largest geometry up to 1080
// lines, then frame rate, then NV12 > YUY2 > UYVY > MJPG.
#include "capture/uvc_format_select.h"

#include <cstdlib>
#include <cstring>
#include <iostream>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "uvc_format_select_test failed: " << m << std::endl; std::exit(1); }

static UvcFormatCandidate mode(uint32_t w, uint32_t h, uint32_t num, uint32_t den, UvcSubtype subtype) {
  UvcFormatCandidate c;
  c.width = w;
  c.height = h;
  c.fpsNum = num;
  c.fpsDen = den;
  c.subtype = subtype;
  return c;
}

int main() {
  if (selectUvcFormat({}) != -1) fail("empty list");

  // A switcher announces one geometry per video standard in several subtypes: uncompressed wins.
  if (selectUvcFormat({mode(1920, 1080, 60, 1, UvcSubtype::Mjpg), mode(1920, 1080, 60, 1, UvcSubtype::Yuy2),
                       mode(1920, 1080, 60, 1, UvcSubtype::Nv12), mode(1920, 1080, 60, 1, UvcSubtype::Uyvy)}) != 2)
    fail("nv12 before yuy2, uyvy, mjpg");
  if (selectUvcFormat({mode(1920, 1080, 60, 1, UvcSubtype::Mjpg), mode(1920, 1080, 60, 1, UvcSubtype::Uyvy),
                       mode(1920, 1080, 60, 1, UvcSubtype::Yuy2)}) != 2)
    fail("yuy2 before uyvy");
  if (selectUvcFormat({mode(1920, 1080, 60, 1, UvcSubtype::Mjpg), mode(1920, 1080, 60, 1, UvcSubtype::Uyvy)}) != 1)
    fail("uyvy before mjpg");

  // Geometry outranks rate and subtype: 1080p MJPG beats 720p NV12 (MJPG only when the highest mode needs it).
  if (selectUvcFormat({mode(1280, 720, 60, 1, UvcSubtype::Nv12), mode(1920, 1080, 30, 1, UvcSubtype::Mjpg)}) != 1)
    fail("geometry first");
  // Rate outranks subtype at the same geometry: 1080p60 MJPG beats 1080p5 YUY2 (typical USB 2 webcam).
  if (selectUvcFormat({mode(1920, 1080, 5, 1, UvcSubtype::Yuy2), mode(1920, 1080, 60, 1, UvcSubtype::Mjpg)}) != 1)
    fail("rate before subtype");
  // Rational rates compare exactly: 60000/1001 < 60/1, 30000/1001 > 25/1.
  if (selectUvcFormat({mode(1920, 1080, 60000, 1001, UvcSubtype::Nv12), mode(1920, 1080, 60, 1, UvcSubtype::Yuy2)}) != 1)
    fail("59.94 below 60");
  if (selectUvcFormat({mode(1920, 1080, 25, 1, UvcSubtype::Nv12), mode(1920, 1080, 30000, 1001, UvcSubtype::Yuy2)}) != 1)
    fail("29.97 above 25");

  // Above 1080 lines is never selected, whatever it offers.
  if (selectUvcFormat({mode(3840, 2160, 60, 1, UvcSubtype::Nv12), mode(1920, 1080, 30, 1, UvcSubtype::Yuy2)}) != 1)
    fail("2160 lines excluded");
  if (selectUvcFormat({mode(3840, 2160, 60, 1, UvcSubtype::Nv12)}) != -1) fail("only 2160 lines");
  if (selectUvcFormat({mode(1920, 1080, 60, 1, UvcSubtype::Nv12), mode(1920, 1081, 60, 1, UvcSubtype::Nv12)}) != 0)
    fail("1081 lines excluded");

  // Unknown subtypes (H.264, RGB24, ...) and empty geometries are skipped.
  if (selectUvcFormat({mode(1920, 1080, 60, 1, UvcSubtype::Other), mode(1280, 720, 30, 1, UvcSubtype::Yuy2)}) != 1)
    fail("other subtype skipped");
  if (selectUvcFormat({mode(1920, 1080, 60, 1, UvcSubtype::Other)}) != -1) fail("only other subtype");
  if (selectUvcFormat({mode(0, 1080, 60, 1, UvcSubtype::Nv12), mode(1920, 0, 60, 1, UvcSubtype::Nv12)}) != -1)
    fail("empty geometry");

  // A mode without a rate still wins on geometry, and loses to a rated one at the same geometry.
  if (selectUvcFormat({mode(1280, 720, 30, 1, UvcSubtype::Nv12), mode(1920, 1080, 0, 0, UvcSubtype::Yuy2)}) != 1)
    fail("missing rate keeps geometry");
  if (selectUvcFormat({mode(1920, 1080, 0, 0, UvcSubtype::Nv12), mode(1920, 1080, 30, 1, UvcSubtype::Yuy2)}) != 1)
    fail("missing rate below a rated mode");

  // Ties keep the device's order.
  if (selectUvcFormat({mode(1920, 1080, 60, 1, UvcSubtype::Nv12), mode(1920, 1080, 60, 1, UvcSubtype::Nv12)}) != 0)
    fail("tie keeps the first");

  // Without an MJPG decoder the next best uncompressed mode is taken.
  const std::vector<UvcFormatCandidate> webcam = {mode(1920, 1080, 30, 1, UvcSubtype::Mjpg), mode(1280, 720, 10, 1, UvcSubtype::Yuy2),
                                                  mode(640, 480, 30, 1, UvcSubtype::Yuy2)};
  if (selectUvcFormat(webcam) != 0) fail("mjpg for the highest mode");
  if (selectUvcFormat(webcam, false) != 1) fail("mjpg left out");
  if (selectUvcFormat({mode(1920, 1080, 30, 1, UvcSubtype::Mjpg)}, false) != -1) fail("only mjpg, left out");

  if (std::strcmp(uvcSubtypeName(UvcSubtype::Nv12), "nv12") != 0 || std::strcmp(uvcSubtypeName(UvcSubtype::Yuy2), "yuy2") != 0 ||
      std::strcmp(uvcSubtypeName(UvcSubtype::Uyvy), "uyvy") != 0 || std::strcmp(uvcSubtypeName(UvcSubtype::Mjpg), "mjpg") != 0 ||
      std::strcmp(uvcSubtypeName(UvcSubtype::Other), "other") != 0)
    fail("subtype names");

  // Error codes match the macOS backend's.
  if (std::strcmp(uvcOpenErrorCode(0x80070005u), "camera_permission_denied") != 0) fail("access denied");
  if (std::strcmp(uvcOpenErrorCode(0xC00D36B4u), "unsupported_format") != 0) fail("invalid media type");
  if (std::strcmp(uvcOpenErrorCode(0xC00D3704u), "device_in_use") != 0) fail("failed start streaming");
  if (std::strcmp(uvcOpenErrorCode(0x80070020u), "device_in_use") != 0) fail("sharing violation");
  if (std::strcmp(uvcOpenErrorCode(0x80004005u), "device_in_use") != 0) fail("unspecified failure");

  std::cout << "uvc_format_select_test passed" << std::endl;
  return 0;
}
