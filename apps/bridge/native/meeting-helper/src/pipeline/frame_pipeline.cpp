#include "pipeline/frame_pipeline.h"

#include "compose/compositor.h"
#include "framebus_reader.h"
#include "framebus_writer.h"
#include "keyer/keyer_chain.h"
#include "util/json_utils.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace broadify::meeting {
namespace {

constexpr uint32_t kSlotCount = 3;
constexpr uint32_t kMaxAlphaDilateRadiusPx = 8;
constexpr uint32_t kMaxAlphaFeatherRadiusPx = 3;
constexpr uint8_t kTemporalAlphaDecay = 64;
constexpr uint64_t kTemporalAlphaMaxAgeNs = 250000000u;
constexpr const char *kMeetingGraphicsFrameBusName = "bfy-meet-gfx";

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

void dilateAlpha(VideoFrame &frame, uint32_t radius) {
  if (frame.rgba.empty() || frame.width == 0u || frame.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(frame.width) * frame.height;
  std::vector<uint8_t> sourceAlpha(pixelCount);
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> dilatedAlpha(pixelCount);

  for (size_t index = 0; index < pixelCount; ++index) {
    sourceAlpha[index] = frame.rgba[index * 4u + 3u];
  }

  for (uint32_t y = 0; y < frame.height; ++y) {
    for (uint32_t x = 0; x < frame.width; ++x) {
      uint8_t maxAlpha = 0u;
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(frame.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        maxAlpha = std::max(maxAlpha, sourceAlpha[static_cast<size_t>(y) * frame.width + sampleX]);
      }
      horizontalAlpha[static_cast<size_t>(y) * frame.width + x] = maxAlpha;
    }
  }

  for (uint32_t y = 0; y < frame.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(frame.height - 1u, y + radius);
    for (uint32_t x = 0; x < frame.width; ++x) {
      uint8_t maxAlpha = 0u;
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        maxAlpha = std::max(maxAlpha, horizontalAlpha[static_cast<size_t>(sampleY) * frame.width + x]);
      }
      dilatedAlpha[static_cast<size_t>(y) * frame.width + x] = maxAlpha;
    }
  }

  for (size_t index = 0; index < pixelCount; ++index) {
    frame.rgba[index * 4u + 3u] = dilatedAlpha[index];
  }
}

void featherAlpha(VideoFrame &frame, uint32_t radius) {
  if (frame.rgba.empty() || frame.width == 0u || frame.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(frame.width) * frame.height;
  std::vector<uint8_t> sourceAlpha(pixelCount);
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> featheredAlpha(pixelCount);

  for (size_t index = 0; index < pixelCount; ++index) {
    sourceAlpha[index] = frame.rgba[index * 4u + 3u];
  }

  for (uint32_t y = 0; y < frame.height; ++y) {
    for (uint32_t x = 0; x < frame.width; ++x) {
      uint32_t sumAlpha = 0u;
      uint32_t sampleCount = 0u;
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(frame.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        sumAlpha += sourceAlpha[static_cast<size_t>(y) * frame.width + sampleX];
        ++sampleCount;
      }
      horizontalAlpha[static_cast<size_t>(y) * frame.width + x] =
          static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    }
  }

  for (uint32_t y = 0; y < frame.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(frame.height - 1u, y + radius);
    for (uint32_t x = 0; x < frame.width; ++x) {
      uint32_t sumAlpha = 0u;
      uint32_t sampleCount = 0u;
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        sumAlpha += horizontalAlpha[static_cast<size_t>(sampleY) * frame.width + x];
        ++sampleCount;
      }
      featheredAlpha[static_cast<size_t>(y) * frame.width + x] =
          static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    }
  }

  for (size_t index = 0; index < pixelCount; ++index) {
    frame.rgba[index * 4u + 3u] = featheredAlpha[index];
  }
}

void stabilizeAlpha(VideoFrame &frame, const VideoFrame &previousFrame) {
  if (frame.rgba.empty() ||
      previousFrame.rgba.empty() ||
      frame.width == 0u ||
      frame.height == 0u ||
      frame.width != previousFrame.width ||
      frame.height != previousFrame.height ||
      frame.timestampNs <= previousFrame.timestampNs ||
      frame.timestampNs - previousFrame.timestampNs > kTemporalAlphaMaxAgeNs) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(frame.width) * frame.height;
  for (size_t index = 0; index < pixelCount; ++index) {
    const size_t offset = index * 4u + 3u;
    const uint8_t currentAlpha = frame.rgba[offset];
    const uint8_t previousAlpha = previousFrame.rgba[offset];
    if (previousAlpha <= currentAlpha || previousAlpha <= kTemporalAlphaDecay) {
      continue;
    }
    frame.rgba[offset] = std::max(currentAlpha, static_cast<uint8_t>(previousAlpha - kTemporalAlphaDecay));
  }
}

uint32_t dynamicDilationRadius(const KeyerSettings &settings, double maskAgeMs) {
  uint32_t radius = std::min(settings.maskDilatePx, kMaxAlphaDilateRadiusPx);
  if (!settings.dynamicDilation || maskAgeMs < 0.0) {
    return radius;
  }
  if (maskAgeMs >= 200.0) {
    radius += 4u;
  } else if (maskAgeMs >= 132.0) {
    radius += 3u;
  } else if (maskAgeMs >= 66.0) {
    radius += 2u;
  }
  return std::min(radius, kMaxAlphaDilateRadiusPx);
}

void postprocessAlpha(VideoFrame &frame,
                      const KeyerSettings &settings,
                      double maskAgeMs,
                      KeyerMetrics &metrics) {
  const auto start = std::chrono::steady_clock::now();
  const auto dilateStart = std::chrono::steady_clock::now();
  dilateAlpha(frame, dynamicDilationRadius(settings, maskAgeMs));
  const auto dilateEnd = std::chrono::steady_clock::now();
  featherAlpha(frame, std::min(settings.maskFeatherPx, kMaxAlphaFeatherRadiusPx));
  const auto end = std::chrono::steady_clock::now();
  metrics.maskDilateMs = elapsedMs(dilateStart, dilateEnd);
  metrics.maskPostprocessMs = elapsedMs(start, end);
}

void applyLatestAlphaToCurrentFrame(const VideoFrame &currentFrame,
                                    const VideoFrame &latestKeyedFrame,
                                    VideoFrame &outputFrame) {
  outputFrame = currentFrame;
  if (currentFrame.rgba.empty() ||
      latestKeyedFrame.rgba.empty() ||
      currentFrame.width == 0u ||
      currentFrame.height == 0u ||
      latestKeyedFrame.width == 0u ||
      latestKeyedFrame.height == 0u) {
    return;
  }

  for (uint32_t y = 0; y < currentFrame.height; ++y) {
    const uint32_t maskY = static_cast<uint32_t>(
        (static_cast<uint64_t>(y) * latestKeyedFrame.height) / currentFrame.height);
    for (uint32_t x = 0; x < currentFrame.width; ++x) {
      const uint32_t maskX = static_cast<uint32_t>(
          (static_cast<uint64_t>(x) * latestKeyedFrame.width) / currentFrame.width);
      const size_t frameOffset = (static_cast<size_t>(y) * currentFrame.width + x) * 4u;
      const size_t maskOffset = (static_cast<size_t>(maskY) * latestKeyedFrame.width + maskX) * 4u;
      outputFrame.rgba[frameOffset + 3u] = latestKeyedFrame.rgba[maskOffset + 3u];
    }
  }
}

class AsyncKeyerWorker {
 public:
  AsyncKeyerWorker(const Options &options, MeetingState &state, std::atomic<bool> &running)
      : keyerChain_(options), state_(state), running_(running), thread_(&AsyncKeyerWorker::run, this) {}

  ~AsyncKeyerWorker() {
    stop();
  }

  void submit(const VideoFrame &frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (hasPendingFrame_) {
      ++droppedFrames_;
    }
    pendingFrame_ = frame;
    pendingGeneration_ = generation_;
    hasPendingFrame_ = true;
    cv_.notify_one();
  }

  bool copyLatest(VideoFrame &frame) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasLatestFrame_) {
      return false;
    }
    frame = latestFrame_;
    return true;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    ++generation_;
    hasPendingFrame_ = false;
    hasLatestFrame_ = false;
    droppedFrames_ = 0;
  }

  uint64_t droppedFrames() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return droppedFrames_;
  }

  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
      hasPendingFrame_ = false;
    }
    cv_.notify_one();
    if (thread_.joinable()) {
      thread_.join();
    }
  }

 private:
  void run() {
    while (running_.load()) {
      VideoFrame frame;
      uint64_t generation = 0;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [&]() {
          return stopping_ || !running_.load() || hasPendingFrame_;
        });
        if (stopping_ || !running_.load()) {
          return;
        }
        frame = std::move(pendingFrame_);
        generation = pendingGeneration_;
        hasPendingFrame_ = false;
      }

      KeyerResult keyed = keyerChain_.process(frame, state_);
      VideoFrame previousKeyedFrame;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (hasLatestFrame_) {
          previousKeyedFrame = latestFrame_;
        }
      }
      KeyerSettings settings;
      double maskAgeMs = -1.0;
      {
        std::lock_guard<std::mutex> stateLock(state_.mutex);
        settings.qualityMode = state_.qualityMode;
        settings.maskDilatePx = state_.maskDilatePx;
        settings.maskFeatherPx = state_.maskFeatherPx;
        settings.dynamicDilation = state_.dynamicDilation;
        maskAgeMs = state_.keyerMetrics.maskAgeMs;
      }
      stabilizeAlpha(keyed.frame, previousKeyedFrame);
      postprocessAlpha(keyed.frame, settings, maskAgeMs, keyed.status.metrics);
      bool shouldPublish = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        shouldPublish = !stopping_ && running_.load() && generation == generation_;
        if (shouldPublish) {
          keyed.status.metrics.droppedFrames = droppedFrames_;
          latestFrame_ = std::move(keyed.frame);
          hasLatestFrame_ = !latestFrame_.rgba.empty();
        }
      }
      if (shouldPublish) {
        updateMeetingKeyerStatus(state_, keyed.status);
      }
    }
  }

  KeyerChain keyerChain_;
  MeetingState &state_;
  std::atomic<bool> &running_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::thread thread_;
  VideoFrame pendingFrame_;
  VideoFrame latestFrame_;
  uint64_t generation_ = 0;
  uint64_t pendingGeneration_ = 0;
  uint64_t droppedFrames_ = 0;
  bool hasPendingFrame_ = false;
  bool hasLatestFrame_ = false;
  bool stopping_ = false;
};

class GraphicsFrameBusReader {
 public:
  ~GraphicsFrameBusReader() {
    close();
  }

  bool copyLatest(VideoFrame &frame) {
    ensureOpen();
    if (reader_ == nullptr) {
      return hasLatestFrame_;
    }

    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t fps = 0;
    if (framebus_reader_get_info(reader_, &width, &height, &fps) != 0 || width == 0u || height == 0u) {
      logReaderEvent("info_failed", width, height, fps, 0, 0);
      close();
      return hasLatestFrame_;
    }

    scratch_.assign(static_cast<size_t>(width) * height * 4u, 0u);
    const int result = framebus_reader_copy_latest_rgba(reader_, scratch_.data(), static_cast<size_t>(width) * 4u, &lastSeq_);
    if (result == -1) {
      logReaderEvent("copy_failed", width, height, fps, 0, 0);
      close();
      return hasLatestFrame_;
    }
    if (result == 1) {
      uint64_t nonTransparentPixels = 0;
      uint32_t maxAlpha = 0;
      for (size_t index = 3; index < scratch_.size(); index += 4u) {
        const uint32_t alpha = scratch_[index];
        if (alpha > 0u) {
          ++nonTransparentPixels;
          maxAlpha = std::max(maxAlpha, alpha);
        }
      }
      latestFrame_.width = width;
      latestFrame_.height = height;
      latestFrame_.timestampNs = nowNs();
      latestFrame_.rgba = scratch_;
      hasLatestFrame_ = true;
      logReaderEvent("frame_read", width, height, fps, nonTransparentPixels, maxAlpha);
    }

    if (hasLatestFrame_) {
      frame = latestFrame_;
    }
    return hasLatestFrame_;
  }

 private:
  void ensureOpen() {
    if (reader_ != nullptr) {
      return;
    }
    reader_ = framebus_reader_open(kMeetingGraphicsFrameBusName);
    lastSeq_ = 0;
    if (reader_ == nullptr) {
      logReaderEvent("open_failed", 0, 0, 0, 0, 0);
    } else {
      logReaderEvent("opened", 0, 0, 0, 0, 0);
    }
  }

  void close() {
    if (reader_ != nullptr) {
      framebus_reader_close(reader_);
      reader_ = nullptr;
      logReaderEvent("closed", 0, 0, 0, 0, 0);
    }
    lastSeq_ = 0;
  }

  void logReaderEvent(const char *event,
                      uint32_t width,
                      uint32_t height,
                      uint32_t fps,
                      uint64_t nonTransparentPixels,
                      uint32_t maxAlpha) {
    if (lastLoggedSeq_ == lastSeq_ && std::string(event) == lastLoggedEvent_) {
      return;
    }
    lastLoggedSeq_ = lastSeq_;
    lastLoggedEvent_ = event;
    std::cout << "{\"type\":\"meeting_graphics_framebus\",\"event\":\"" << event
              << "\",\"name\":\"" << kMeetingGraphicsFrameBusName
              << "\",\"seq\":" << lastSeq_
              << ",\"width\":" << width
              << ",\"height\":" << height
              << ",\"fps\":" << fps
              << ",\"non_transparent_pixels\":" << nonTransparentPixels
              << ",\"max_alpha\":" << maxAlpha
              << "}" << std::endl;
  }

  framebus_reader_t *reader_ = nullptr;
  uint64_t lastSeq_ = 0;
  uint64_t lastLoggedSeq_ = 0;
  std::string lastLoggedEvent_;
  bool hasLatestFrame_ = false;
  VideoFrame latestFrame_;
  std::vector<uint8_t> scratch_;
};

}  // namespace

void runFramePipeline(const Options &options,
                      MeetingState &state,
                      CameraSource &camera,
                      PreviewFrameStore &previewFrames,
                      std::atomic<bool> &running) {
  framebus_writer_t *writer = framebus_writer_open(
      options.framebusName.c_str(), options.width, options.height, options.fps, kSlotCount);
  if (writer == nullptr) {
    std::cout << "{\"type\":\"error\",\"code\":\"framebus_open_failed\",\"message\":\"Could not create FrameBus segment.\"}" << std::endl;
    return;
  }

  const auto sleepFor = std::chrono::milliseconds(1000 / (options.fps == 0 ? 30 : options.fps));
  uint64_t frameIndex = 0;
  std::vector<uint8_t> programFrame;
  AsyncKeyerWorker keyerWorker(options, state, running);
  GraphicsFrameBusReader graphicsReader;
  while (running.load()) {
    bool framebusRunning = true;
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      framebusRunning = state.framebusRunning;
      state.cameraRunning = camera.isRunning();
      state.activeCameraIndex = camera.activeCameraIndex();
    }

    if (framebusRunning) {
      const auto programStart = std::chrono::steady_clock::now();
      VideoFrame frame;
      const auto cameraCopyStart = std::chrono::steady_clock::now();
      const bool hasCameraFrame = camera.copyLatestFrame(frame) && !frame.rgba.empty();
      const auto cameraCopyEnd = std::chrono::steady_clock::now();
      const CompositorSnapshot snapshot = copyCompositorSnapshot(state);
      VideoFrame keyedFrame;
      const VideoFrame *frameForCompositor = nullptr;
      if (hasCameraFrame) {
        if (snapshot.keyerEnabled) {
          keyerWorker.submit(frame);
          VideoFrame latestKeyedFrame;
          if (keyerWorker.copyLatest(latestKeyedFrame)) {
            applyLatestAlphaToCurrentFrame(frame, latestKeyedFrame, keyedFrame);
            frameForCompositor = &keyedFrame;
            {
              std::lock_guard<std::mutex> lock(state.mutex);
              if (frame.timestampNs >= latestKeyedFrame.timestampNs) {
                state.keyerMetrics.maskAgeMs =
                    static_cast<double>(frame.timestampNs - latestKeyedFrame.timestampNs) / 1000000.0;
              } else {
                state.keyerMetrics.maskAgeMs = 0.0;
              }
              state.keyerMetrics.droppedFrames = keyerWorker.droppedFrames();
            }
          } else {
            frameForCompositor = &frame;
          }
        } else {
          keyerWorker.clear();
          frameForCompositor = &frame;
        }
      } else {
        keyerWorker.clear();
      }
      VideoFrame graphicsFrame;
      const VideoFrame *graphicsFrameForCompositor = graphicsReader.copyLatest(graphicsFrame) ? &graphicsFrame : nullptr;
      renderProgramFrame(options, snapshot, frameForCompositor, graphicsFrameForCompositor, frameIndex++, programFrame);
      framebus_writer_write_rgba(writer, programFrame.data(), programFrame.size(), hasCameraFrame ? frame.timestampNs : nowNs());
      previewFrames.publish(options.width, options.height, programFrame.data(), programFrame.size());
      const auto programEnd = std::chrono::steady_clock::now();
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        state.keyerMetrics.programFrameMs = elapsedMs(programStart, programEnd);
        state.keyerMetrics.cameraCopyMs = elapsedMs(cameraCopyStart, cameraCopyEnd);
      }
    } else {
      keyerWorker.clear();
    }
    std::this_thread::sleep_for(sleepFor);
  }
  framebus_writer_close(writer);
}

}  // namespace broadify::meeting
