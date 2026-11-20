#pragma once

#if defined(__APPLE__)

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>

#include "recorder/recorder_encode_policy.h"
#include "recorder/recorder_frame_mailbox.h"

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

namespace broadify::meeting {

// Encodes program frames for the macOS meeting recorder on its own thread.
//
// The pipeline tick only hands the RGBA frame to offer() (one memcpy into
// the mailbox, measured ~0.2 ms for 1080p) and returns; this worker performs
// the RGBA->BGRA swizzle into a pooled CVPixelBuffer, the constant-frame-rate
// planning (RecorderFrameClock, fed with the CAPTURE time the tick recorded,
// never the worker's own clock) and the AVAssetWriter append. A frame the
// mailbox had to replace because the encoder fell behind is counted as
// dropped (droppedFrames + mailboxReplaced) and reported through a
// rate-limited "mailbox_replaced" recorder event.
//
// Lifecycle: start() spawns the thread, stop() stops accepting, drains what
// is pending, joins the thread and returns; the owner finishes the writer
// afterwards. Both are idempotent and the destructor stops.
class RecorderVideoWorker {
 public:
  struct Config {
    AVAssetWriter *writer = nil;
    AVAssetWriterInput *videoInput = nil;
    AVAssetWriterInputPixelBufferAdaptor *videoAdaptor = nil;
    CMTime sessionStart = kCMTimeInvalid;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t fps = 30;
    bool cfrEnabled = true;
  };

  struct Counters {
    uint64_t offered = 0;           // frames the tick offered
    uint64_t videoFrames = 0;       // samples appended to the writer
    uint64_t duplicatedFrames = 0;  // CFR fill samples among videoFrames
    uint64_t droppedFrames = 0;     // mailbox replacements + CFR drops
    uint64_t queuedFrames = 0;      // pending in the mailbox right now
    uint64_t mailboxReplaced = 0;   // part of droppedFrames
  };

  explicit RecorderVideoWorker(Config config);
  ~RecorderVideoWorker();

  RecorderVideoWorker(const RecorderVideoWorker &) = delete;
  RecorderVideoWorker &operator=(const RecorderVideoWorker &) = delete;

  void start();

  // Pipeline thread. Returns false when the geometry does not match the
  // configured one or the worker is stopped.
  bool offer(const uint8_t *rgba, uint32_t width, uint32_t height,
             uint64_t captureElapsedNs);

  // Stops accepting, drains the mailbox, joins the thread.
  void stop();

  Counters counters() const;

  // First writer failure seen by the worker (REC-02), empty when none.
  std::string lastError() const;

 private:
  void run();
  void encodeFrame(const RecorderMailboxFrame &frame);
  bool waitForVideoInputReady();
  void noteWriterFailureLocked();
  void reportReplacedFrames();

  Config config_;
  RecorderFrameMailbox mailbox_;
  std::thread thread_;
  bool started_ = false;
  bool stopped_ = false;

  mutable std::mutex mutex_;
  RecorderFrameClock frameClock_;
  uint64_t videoFrames_ = 0;
  uint64_t duplicatedFrames_ = 0;
  uint64_t cfrDroppedFrames_ = 0;
  bool cfrDropLogged_ = false;
  bool cfrDiscontinuityLogged_ = false;
  uint64_t replacedReported_ = 0;
  std::chrono::steady_clock::time_point replacedReportedAt_{};
  std::string lastError_;
};

}  // namespace broadify::meeting

#endif  // __APPLE__
