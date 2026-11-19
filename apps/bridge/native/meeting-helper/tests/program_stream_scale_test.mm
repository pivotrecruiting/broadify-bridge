// Regression for the program-stream pixel buffer overflow. The program stream
// converts each RGBA program frame into a pooled BGRA CVPixelBuffer; the pool
// used to be created at the ENCODE TARGET size while the copy wrote FRAME-size
// rows, so a 1920x1080 program with the "remote" profile (target 1280x720) or
// any program taller than 1080 lines wrote past the buffer. Drives the
// production pool + copy the way ProgramStream::Impl::encodeFrame does, then
// hands the buffer to VideoToolbox to pin that the encoder session scales a
// frame-size buffer to the target (skipped without a hardware encoder).
// Needs no camera and no WebRTC peer.
#import <CoreVideo/CoreVideo.h>

#include "live/program_stream_frame_copy.h"
#include "live_stream/bitrate_ladder.h"
#include "live_stream/video_encoder.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace broadify::live;
using namespace broadify::meeting;

static void fail(const std::string &m) {
  std::cerr << "program_stream_scale_test failed: " << m << std::endl;
  std::exit(1);
}

static std::vector<uint8_t> makeRgbaFrame(uint32_t width, uint32_t height) {
  std::vector<uint8_t> rgba(static_cast<size_t>(width) * height * 4);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      uint8_t *px = rgba.data() + (static_cast<size_t>(y) * width + x) * 4;
      px[0] = static_cast<uint8_t>(x & 0xff);
      px[1] = static_cast<uint8_t>(y & 0xff);
      px[2] = static_cast<uint8_t>((x + y) & 0xff);
      px[3] = 0xff;
    }
  }
  return rgba;
}

static void expectPixel(CVPixelBufferRef buffer, uint32_t x, uint32_t y, const std::string &label) {
  const uint8_t *base = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(buffer));
  const uint8_t *px = base + static_cast<size_t>(y) * CVPixelBufferGetBytesPerRow(buffer) + static_cast<size_t>(x) * 4;
  // BGRA in the buffer, RGBA pattern from makeRgbaFrame.
  if (px[0] != static_cast<uint8_t>((x + y) & 0xff) || px[1] != static_cast<uint8_t>(y & 0xff) ||
      px[2] != static_cast<uint8_t>(x & 0xff) || px[3] != 0xff) {
    fail(label + ": pixel " + std::to_string(x) + "," + std::to_string(y) + " was not copied");
  }
}

// The stage step of ProgramStream::Impl::encodeFrame: pooled buffer for this frame + one copy pass.
static CVPixelBufferRef stageFrame(ProgramFramePool &pool, const std::vector<uint8_t> &rgba, uint32_t width, uint32_t height,
                                   const std::string &label) {
  if (!pool.ensure(width, height)) fail(label + ": pool");
  CVPixelBufferRef buffer = pool.createBuffer();
  if (buffer == nullptr) fail(label + ": no pooled buffer");
  if (!copyRgbaFrameToPixelBuffer(rgba.data(), rgba.size(), width, height, buffer)) fail(label + ": frame was not copied");
  if (CVPixelBufferGetWidth(buffer) != width || CVPixelBufferGetHeight(buffer) != height) {
    fail(label + ": pooled buffer is " + std::to_string(CVPixelBufferGetWidth(buffer)) + "x" +
         std::to_string(CVPixelBufferGetHeight(buffer)) + ", the frame is " + std::to_string(width) + "x" + std::to_string(height));
  }
  CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
  expectPixel(buffer, 0, 0, label);
  expectPixel(buffer, width - 1, 0, label);
  expectPixel(buffer, width / 2, height / 2, label);
  expectPixel(buffer, 0, height - 1, label);
  expectPixel(buffer, width - 1, height - 1, label);
  CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
  return buffer;
}

// A frame-size buffer into an encoder session at the (smaller) target size: VideoToolbox scales.
// Returns false when the machine has no hardware encoder.
static bool encodeScaled(CVPixelBufferRef buffer, uint32_t width, uint32_t height, EncodeProfile profile, const std::string &label) {
  auto encoder = createVideoToolboxEncoder();
  const EncodeTarget target = selectEncodeTarget(width, height, 30, 1, profile);
  std::string code;
  std::string error;
  if (!encoder->configure(target, code, error)) {
    if (code == "encoder_unavailable") {
      return false;
    }
    fail(label + ": " + error);
  }
  std::mutex mutex;
  size_t units = 0;
  encoder->onAccessUnit = [&](EncodedAccessUnit &&unit) {
    if (unit.sample != nullptr) {
      CFRelease(unit.sample);
      unit.sample = nullptr;
    }
    std::lock_guard<std::mutex> lock(mutex);
    ++units;
  };
  for (int i = 0; i < 5; ++i) {
    CapturedFrame frame;
    frame.pixelBuffer = buffer;
    frame.width = width;
    frame.height = height;
    frame.pixelFormat = "bgra";
    frame.captureNs = 1'000'000'000ULL + static_cast<uint64_t>(i) * 33'333'333ULL;
    if (!encoder->encode(frame, i == 0)) fail(label + ": encoder rejected a frame-size buffer");
  }
  encoder->flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  std::lock_guard<std::mutex> lock(mutex);
  if (units == 0) fail(label + ": no access unit from a frame-size buffer");
  return true;
}

int main() {
  struct Case {
    uint32_t width;
    uint32_t height;
    EncodeProfile profile;
    const char *label;
  };
  const Case cases[] = {
      {1920, 1080, EncodeProfile::Lan, "1920x1080 lan (target == frame)"},
      {1920, 1080, EncodeProfile::Remote, "1920x1080 remote (target 1280x720)"},
      {1080, 1920, EncodeProfile::Lan, "1080x1920 lan"},
      {1080, 1920, EncodeProfile::Remote, "1080x1920 remote"},
  };
  bool encoded = true;
  ProgramFramePool pool;  // one pool across the cases, as one stream sees a program format change
  for (const Case &c : cases) {
    const std::vector<uint8_t> rgba = makeRgbaFrame(c.width, c.height);
    CVPixelBufferRef buffer = stageFrame(pool, rgba, c.width, c.height, c.label);
    encoded = encodeScaled(buffer, c.width, c.height, c.profile, c.label) && encoded;
    CVPixelBufferRelease(buffer);
  }

  // The copy is bounded by the buffer it is given: a frame that does not match is refused, not clipped or overrun.
  {
    CVPixelBufferRef small = nullptr;
    if (CVPixelBufferCreate(kCFAllocatorDefault, 1280, 720, kCVPixelFormatType_32BGRA, nullptr, &small) != kCVReturnSuccess) fail("small buffer");
    const std::vector<uint8_t> rgba = makeRgbaFrame(1920, 1080);
    if (copyRgbaFrameToPixelBuffer(rgba.data(), rgba.size(), 1920, 1080, small)) fail("a 1920x1080 frame must not be copied into a 1280x720 buffer");
    if (copyRgbaFrameToPixelBuffer(rgba.data(), rgba.size(), 1080, 1920, small)) fail("a 1080x1920 frame must not be copied into a 1280x720 buffer");
    if (copyRgbaFrameToPixelBuffer(rgba.data(), 1280 * 720 * 4 - 1, 1280, 720, small)) fail("a short rgba payload must not be copied");
    if (copyRgbaFrameToPixelBuffer(rgba.data(), rgba.size(), 1280, 720, nullptr)) fail("a missing buffer must not be copied into");
    if (!copyRgbaFrameToPixelBuffer(rgba.data(), rgba.size(), 1280, 720, small)) fail("a matching frame must be copied");
    CVPixelBufferRelease(small);
  }

  // The pool follows the program frame size; an empty size is refused.
  {
    ProgramFramePool sized;
    if (sized.createBuffer() != nullptr) fail("an unconfigured pool must not hand out buffers");
    if (sized.ensure(0, 1080) || sized.ensure(1920, 0)) fail("an empty frame size must be refused");
    if (!sized.ensure(1920, 1080) || !sized.ensure(1920, 1080)) fail("pool 1920x1080");
    CVPixelBufferRef landscape = sized.createBuffer();
    if (landscape == nullptr || CVPixelBufferGetWidth(landscape) != 1920 || CVPixelBufferGetHeight(landscape) != 1080) fail("1920x1080 buffer");
    if (!sized.ensure(1080, 1920)) fail("pool 1080x1920");
    CVPixelBufferRef portrait = sized.createBuffer();
    if (portrait == nullptr || CVPixelBufferGetWidth(portrait) != 1080 || CVPixelBufferGetHeight(portrait) != 1920) fail("pool was not recreated for 1080x1920");
    CVPixelBufferRelease(landscape);
    CVPixelBufferRelease(portrait);
    sized.reset();
    if (sized.createBuffer() != nullptr) fail("a reset pool must not hand out buffers");
  }

  std::cout << "program_stream_scale_test passed"
            << (encoded ? " (VideoToolbox scaled the frame-size buffers)" : " (no hardware encoder: scaling not exercised)") << std::endl;
  return 0;
}
