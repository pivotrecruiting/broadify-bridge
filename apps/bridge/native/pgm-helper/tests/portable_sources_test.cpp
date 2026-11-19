// The plain C++ backends the Windows helper is built from, run on every
// platform: synthetic NV12 source, copying frame holder + snapshot, recorder stub.
#include "capture/frame_holder.h"
#include "capture/snapshot.h"
#include "capture/video_source.h"
#include "recorder/mp4_recorder.h"

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <thread>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "portable_sources_test failed: " << m << std::endl; std::exit(1); }

int main() {
  // --- synthetic source ---------------------------------------------------
  std::unique_ptr<VideoSource> source = createSyntheticSource(320, 180, 50.0);
  if (!source) fail("no synthetic source");
  if (!source->decode().empty()) fail("synthetic source decodes nothing");

  std::mutex mutex;
  std::condition_variable cv;
  int frames = 0;
  bool shapeOk = true;
  uint64_t firstNs = 0;
  uint64_t lastNs = 0;
  uint8_t counterCell[2] = {0, 0};  // luma of frame counter bit 0 in frame 0 and frame 1
  std::shared_ptr<const RetainedFrame> retained;
  int retainedCount = 0;
  std::string code;
  std::string error;
  const bool started = source->start(
      [&](const CapturedFrame &frame) {
        std::lock_guard<std::mutex> lock(mutex);
        if (frame.width != 320 || frame.height != 180 || frame.pixelFormat != "nv12" || frame.planeCount != 2 ||
            frame.planes[0].data == nullptr || frame.planes[0].stride < 320 || frame.planes[0].rows != 180 ||
            frame.planes[1].data == nullptr || frame.planes[1].stride < 320 || frame.planes[1].rows != 90 || frame.nativeHandle != nullptr ||
            frame.captureNs == 0 || frame.captureNs < lastNs) {
          shapeOk = false;
        }
        if (frames == 0) firstNs = frame.captureNs;
        if (frames < 2) counterCell[frames] = frame.planes[0].data[16 * frame.planes[0].stride + 16];
        lastNs = frame.captureNs;
        if (std::shared_ptr<const RetainedFrame> kept = retainFrame(frame)) {
          retained = std::move(kept);
          retainedCount += 1;
        }
        frames += 1;
        cv.notify_all();
      },
      code, error);
  if (!started || !code.empty()) fail("synthetic source did not start");
  if (!source->isRunning()) fail("isRunning after start");
  {
    std::unique_lock<std::mutex> lock(mutex);
    if (!cv.wait_for(lock, std::chrono::seconds(10), [&] { return frames >= 25; })) fail("fewer than 25 frames in 10 s");
  }
  source->stop();
  if (source->isRunning()) fail("isRunning after stop");
  int framesAfterStop = 0;
  {
    std::lock_guard<std::mutex> lock(mutex);
    framesAfterStop = frames;
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  {
    std::lock_guard<std::mutex> lock(mutex);
    if (frames != framesAfterStop) fail("frames after stop");
    if (!shapeOk) fail("frame shape");
    // 24 intervals at 50 fps are 480 ms; a loaded CI machine may stretch that, it must never be much shorter.
    if (lastNs - firstNs < 300'000'000ULL) fail("frames arrive faster than the requested rate");
    // Frame counter in the top-left corner: bit 0 is black in frame 0 and white in frame 1.
    if (counterCell[0] != 16 || counterCell[1] != 235) fail("frame counter cells");
    // The holder copies at most every 200 ms, and always the first frame.
    if (!retained || retainedCount < 1 || retainedCount >= frames) fail("frame holder throttle");
  }

  // --- frame holder + snapshot --------------------------------------------
  // The retained copy outlives the source and its buffers.
  source.reset();
  const CapturedFrame &kept = retained->frame();
  if (kept.width != 320 || kept.height != 180 || kept.planeCount != 2 || kept.nativeHandle != nullptr) fail("retained frame shape");
  // Right-most bar is black (Y 16), left-most below the counter is white (Y 235).
  if (kept.planes[0].data[100 * kept.planes[0].stride + 319] != 16 || kept.planes[0].data[40 * kept.planes[0].stride + 4] != 235)
    fail("retained pixels");
  uint32_t width = 0;
  uint32_t height = 0;
  const std::string jpeg = jpegBase64FromFrame(kept, 0.8, width, height);
  if (jpeg.size() < 100 || width != 320 || height != 180) fail("snapshot of the retained frame");
  if (jpeg.compare(0, 4, "/9j/") != 0) fail("snapshot is not a base64 JPEG");

  CapturedFrame noPlanes;
  noPlanes.width = 320;
  noPlanes.height = 180;
  noPlanes.pixelFormat = "nv12";
  if (retainFrame(noPlanes)) fail("a frame without planes cannot be retained");

  if (createSyntheticSource(320, 180, 0.0)->start([](const CapturedFrame &) {}, code, error) || code != "unsupported_format")
    fail("zero frame rate must not start");

  // --- recorder stub --------------------------------------------------------
  if (Mp4Recorder::supported()) fail("the stub reports no recording backend");
  Mp4Recorder recorder;
  error.clear();
  if (recorder.start("unused.mp4", true, error) || error.empty()) fail("stub start must fail with a message");
  if (recorder.isActive() || recorder.status().active || !recorder.status().filePath.empty()) fail("stub is never active");
  recorder.appendVideo(EncodedAccessUnit{});
  recorder.appendAudio(AudioChunk{});
  if (!recorder.stop(error)) fail("stub stop is a no-op that succeeds");

  std::cout << "portable_sources_test passed" << std::endl;
  return 0;
}
