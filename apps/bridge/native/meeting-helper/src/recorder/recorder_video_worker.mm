#include "recorder/recorder_video_worker.h"

#if defined(__APPLE__)

#include "recorder/recorder_writer_factory.h"

#import <Accelerate/Accelerate.h>
#import <CoreVideo/CoreVideo.h>

#include <string>
#include <unistd.h>

namespace broadify::meeting {

namespace {

// How long the worker waits for the video input to accept more data before
// dropping a planned sample. Off the program tick we can afford one frame
// interval; the former inline path dropped immediately ("cfr_drop encoder
// busy" in field logs).
constexpr int kReadyPollStepUs = 500;

// Minimum spacing of the "mailbox_replaced" recorder event.
constexpr auto kReplacedReportInterval = std::chrono::seconds(5);

}  // namespace

RecorderVideoWorker::RecorderVideoWorker(Config config)
    : config_(std::move(config)),
      frameClock_(config_.fps > 0 ? config_.fps : 30) {
  if (config_.fps == 0) {
    config_.fps = 30;
  }
}

RecorderVideoWorker::~RecorderVideoWorker() { stop(); }

void RecorderVideoWorker::start() {
  if (started_) {
    return;
  }
  started_ = true;
  replacedReportedAt_ = std::chrono::steady_clock::now();
  thread_ = std::thread([this] { run(); });
}

bool RecorderVideoWorker::offer(const uint8_t *rgba, uint32_t width,
                                uint32_t height, uint64_t captureElapsedNs) {
  if (rgba == nullptr || width != config_.width || height != config_.height) {
    return false;  // geometry changed mid-recording; skip until it matches
  }
  return mailbox_.offer(rgba, width, height, captureElapsedNs);
}

void RecorderVideoWorker::stop() {
  if (stopped_) {
    return;
  }
  stopped_ = true;
  mailbox_.stop();
  if (thread_.joinable()) {
    thread_.join();
  }
  reportReplacedFrames();
}

RecorderVideoWorker::Counters RecorderVideoWorker::counters() const {
  const RecorderFrameMailbox::Counters mailbox = mailbox_.counters();
  std::lock_guard<std::mutex> lock(mutex_);
  Counters out;
  out.offered = mailbox.offered;
  out.videoFrames = videoFrames_;
  out.duplicatedFrames = duplicatedFrames_;
  out.droppedFrames = cfrDroppedFrames_ + mailbox.replaced;
  out.queuedFrames = mailbox_.pending();
  out.mailboxReplaced = mailbox.replaced;
  return out;
}

std::string RecorderVideoWorker::lastError() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return lastError_;
}

void RecorderVideoWorker::run() {
  RecorderMailboxFrame scratch;
  while (mailbox_.take(scratch)) {
    @autoreleasepool {
      encodeFrame(scratch);
    }
    reportReplacedFrames();
  }
}

void RecorderVideoWorker::reportReplacedFrames() {
  const uint64_t replaced = mailbox_.counters().replaced;
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mutex_);
  if (replaced == replacedReported_ ||
      now - replacedReportedAt_ < kReplacedReportInterval) {
    return;
  }
  logRecorderEvent("mailbox_replaced",
                   "replaced=" + std::to_string(replaced - replacedReported_) +
                       " total=" + std::to_string(replaced) +
                       " written=" + std::to_string(videoFrames_));
  replacedReported_ = replaced;
  replacedReportedAt_ = now;
}

bool RecorderVideoWorker::waitForVideoInputReady() {
  const int64_t budgetUs = 1000000 / static_cast<int64_t>(config_.fps);
  int64_t waitedUs = 0;
  while (!config_.videoInput.isReadyForMoreMediaData) {
    if (config_.writer.status != AVAssetWriterStatusWriting ||
        waitedUs >= budgetUs) {
      return false;
    }
    usleep(kReadyPollStepUs);
    waitedUs += kReadyPollStepUs;
  }
  return true;
}

void RecorderVideoWorker::noteWriterFailureLocked() {
  if (config_.writer.status == AVAssetWriterStatusFailed &&
      lastError_.empty()) {
    // REC-02: a failed writer (disk full, I/O error) used to be silently
    // ignored - the recording looked healthy while writing nothing. Surface
    // it once via recording.status (which streams to the webapp).
    lastError_ = config_.writer.error != nil
                     ? ([[config_.writer.error localizedDescription] UTF8String]
                            ?: "writer_failed")
                     : "writer_failed";
    logRecorderEvent("writer_failed",
                     describeRecorderError(config_.writer.error, "writer_failed") +
                         " after " + std::to_string(videoFrames_) + " frames");
  }
}

void RecorderVideoWorker::encodeFrame(const RecorderMailboxFrame &frame) {
  if (config_.videoInput == nil || config_.videoAdaptor == nil ||
      !CMTIME_IS_VALID(config_.sessionStart)) {
    return;
  }
  if (frame.width != config_.width || frame.height != config_.height ||
      frame.rgba.size() <
          static_cast<size_t>(config_.width) * config_.height * 4u) {
    return;
  }
  CVPixelBufferPoolRef pool = config_.videoAdaptor.pixelBufferPool;
  if (pool == nullptr) {
    return;
  }
  CVPixelBufferRef pixelBuffer = nullptr;
  if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool,
                                         &pixelBuffer) != kCVReturnSuccess ||
      pixelBuffer == nullptr) {
    return;
  }
  CVPixelBufferLockBaseAddress(pixelBuffer, 0);
  uint8_t *dst = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixelBuffer));
  const size_t dstStride = CVPixelBufferGetBytesPerRow(pixelBuffer);
  // RGBA8 -> BGRA8 (swap R and B) honouring the pixel buffer's row padding.
  vImage_Buffer src{const_cast<uint8_t *>(frame.rgba.data()), frame.height,
                    frame.width, static_cast<size_t>(frame.width) * 4u};
  vImage_Buffer out{dst, frame.height, frame.width, dstStride};
  const uint8_t permuteMap[4] = {2, 1, 0, 3};
  vImagePermuteChannels_ARGB8888(&src, &out, permuteMap, kvImageNoFlags);
  CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
  CVBufferSetAttachment(pixelBuffer, kCVImageBufferColorPrimariesKey,
                        kCVImageBufferColorPrimaries_ITU_R_709_2,
                        kCVAttachmentMode_ShouldPropagate);
  CVBufferSetAttachment(pixelBuffer, kCVImageBufferTransferFunctionKey,
                        kCVImageBufferTransferFunction_ITU_R_709_2,
                        kCVAttachmentMode_ShouldPropagate);
  CVBufferSetAttachment(pixelBuffer, kCVImageBufferYCbCrMatrixKey,
                        kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                        kCVAttachmentMode_ShouldPropagate);

  std::lock_guard<std::mutex> lock(mutex_);
  if (!config_.cfrEnabled) {
    // Legacy host-clock PTS path (BROADIFY_MEETING_RECORDER_CFR=0): the
    // frame's capture time stamps the sample.
    const CMTime presentationTime = CMTimeAdd(
        config_.sessionStart,
        CMTimeMake(static_cast<int64_t>(frame.captureElapsedNs), 1000000000));
    if (!waitForVideoInputReady()) {
      ++cfrDroppedFrames_;
      noteWriterFailureLocked();
      CVPixelBufferRelease(pixelBuffer);
      return;
    }
    if ([config_.videoAdaptor appendPixelBuffer:pixelBuffer
                           withPresentationTime:presentationTime]) {
      ++videoFrames_;
    } else {
      noteWriterFailureLocked();
    }
    CVPixelBufferRelease(pixelBuffer);
    return;
  }

  const RecorderFrameClock::Plan plan = frameClock_.plan(frame.captureElapsedNs);
  if (plan.discontinuity && !cfrDiscontinuityLogged_) {
    logRecorderEvent("cfr_discontinuity",
                     "jumped to frame " + std::to_string(plan.firstIndex));
    cfrDiscontinuityLogged_ = true;
  }
  uint32_t written = 0;
  for (uint32_t i = 0; i < plan.count; ++i) {
    if (!waitForVideoInputReady()) {
      cfrDroppedFrames_ += plan.count - i;
      noteWriterFailureLocked();
      if (!cfrDropLogged_) {
        logRecorderEvent("cfr_drop",
                         "encoder busy at frame " +
                             std::to_string(plan.firstIndex + i));
        cfrDropLogged_ = true;
      }
      break;
    }
    const CMTime presentationTime =
        CMTimeAdd(config_.sessionStart,
                  CMTimeMake(static_cast<int64_t>(plan.firstIndex + i),
                             static_cast<int32_t>(config_.fps)));
    if ([config_.videoAdaptor appendPixelBuffer:pixelBuffer
                           withPresentationTime:presentationTime]) {
      ++written;
    } else {
      noteWriterFailureLocked();
      break;
    }
  }
  frameClock_.commit(written);
  videoFrames_ += written;
  if (written > 1) {
    duplicatedFrames_ += written - 1;
  }
  CVPixelBufferRelease(pixelBuffer);
}

}  // namespace broadify::meeting

#endif  // __APPLE__
