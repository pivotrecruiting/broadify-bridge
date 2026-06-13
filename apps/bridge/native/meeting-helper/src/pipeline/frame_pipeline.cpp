#include "pipeline/frame_pipeline.h"

#include "compose/compositor.h"
#include "framebus_reader.h"
#include "framebus_writer.h"
#include "keyer/keyer_chain.h"
#include "util/json_utils.h"

#include <algorithm>
#include <chrono>
#include <cmath>
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
constexpr uint32_t kTemporalProtectionRadiusPx = 6;
constexpr uint8_t kTemporalProtectionAlphaThreshold = 32;
constexpr uint64_t kTemporalAlphaMaxAgeNs = 250000000u;
constexpr double kStaleMaskAgeMs = 140.0;
constexpr float kSmoothstepLow = 0.12f;
constexpr float kSmoothstepHigh = 0.88f;
constexpr float kQuietPreviousWeight = 0.85f;
constexpr float kMotionPreviousWeight = 0.15f;
constexpr float kStalePreviousWeight = 0.05f;
constexpr const char *kMeetingGraphicsFrameBusName = "bfy-meet-gfx";

struct MaskSample {
  size_t lower = 0u;
  size_t upper = 0u;
  uint32_t upperWeight = 0u;
};

double elapsedMs(std::chrono::steady_clock::time_point start,
                 std::chrono::steady_clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}

float clamp01(float value) {
  return std::clamp(value, 0.0f, 1.0f);
}

float lerp(float start, float end, float amount) {
  return start + (end - start) * amount;
}

float smoothstep(float edge0, float edge1, float value) {
  const float t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3.0f - 2.0f * t);
}

void remapAlphaSmoothstep(AlphaMask &mask) {
  if (mask.alpha.empty()) {
    return;
  }

  for (uint8_t &alpha : mask.alpha) {
    const float normalizedAlpha = static_cast<float>(alpha) / 255.0f;
    alpha = static_cast<uint8_t>(std::round(smoothstep(kSmoothstepLow, kSmoothstepHigh, normalizedAlpha) * 255.0f));
  }
}

void dilateAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> dilatedAlpha(pixelCount);

  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint8_t maxAlpha = 0u;
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(mask.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        maxAlpha = std::max(maxAlpha, mask.alpha[static_cast<size_t>(y) * mask.width + sampleX]);
      }
      horizontalAlpha[static_cast<size_t>(y) * mask.width + x] = maxAlpha;
    }
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(mask.height - 1u, y + radius);
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint8_t maxAlpha = 0u;
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        maxAlpha = std::max(maxAlpha, horizontalAlpha[static_cast<size_t>(sampleY) * mask.width + x]);
      }
      dilatedAlpha[static_cast<size_t>(y) * mask.width + x] = maxAlpha;
    }
  }

  mask.alpha = std::move(dilatedAlpha);
}

void featherAlpha(AlphaMask &mask, uint32_t radius) {
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u || radius == 0u) {
    return;
  }

  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> horizontalAlpha(pixelCount);
  std::vector<uint8_t> featheredAlpha(pixelCount);

  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint32_t sumAlpha = 0u;
      uint32_t sampleCount = 0u;
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(mask.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        sumAlpha += mask.alpha[static_cast<size_t>(y) * mask.width + sampleX];
        ++sampleCount;
      }
      horizontalAlpha[static_cast<size_t>(y) * mask.width + x] =
          static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    }
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(mask.height - 1u, y + radius);
    for (uint32_t x = 0; x < mask.width; ++x) {
      uint32_t sumAlpha = 0u;
      uint32_t sampleCount = 0u;
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        sumAlpha += horizontalAlpha[static_cast<size_t>(sampleY) * mask.width + x];
        ++sampleCount;
      }
      featheredAlpha[static_cast<size_t>(y) * mask.width + x] =
          static_cast<uint8_t>(sumAlpha / std::max(1u, sampleCount));
    }
  }

  mask.alpha = std::move(featheredAlpha);
}

std::vector<uint8_t> alphaProtectionMask(const AlphaMask &mask, uint32_t radius) {
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  std::vector<uint8_t> sourceMask(pixelCount);
  std::vector<uint8_t> horizontalMask(pixelCount);
  std::vector<uint8_t> protectionMask(pixelCount);

  for (size_t index = 0; index < pixelCount; ++index) {
    sourceMask[index] = mask.alpha[index] >= kTemporalProtectionAlphaThreshold ? 1u : 0u;
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    for (uint32_t x = 0; x < mask.width; ++x) {
      const uint32_t minX = x > radius ? x - radius : 0u;
      const uint32_t maxX = std::min(mask.width - 1u, x + radius);
      for (uint32_t sampleX = minX; sampleX <= maxX; ++sampleX) {
        if (sourceMask[static_cast<size_t>(y) * mask.width + sampleX] != 0u) {
          horizontalMask[static_cast<size_t>(y) * mask.width + x] = 1u;
          break;
        }
      }
    }
  }

  for (uint32_t y = 0; y < mask.height; ++y) {
    const uint32_t minY = y > radius ? y - radius : 0u;
    const uint32_t maxY = std::min(mask.height - 1u, y + radius);
    for (uint32_t x = 0; x < mask.width; ++x) {
      for (uint32_t sampleY = minY; sampleY <= maxY; ++sampleY) {
        if (horizontalMask[static_cast<size_t>(sampleY) * mask.width + x] != 0u) {
          protectionMask[static_cast<size_t>(y) * mask.width + x] = 1u;
          break;
        }
      }
    }
  }

  return protectionMask;
}

void blendAlphaTemporal(AlphaMask &mask, const AlphaMask &previousMask, double maskAgeMs) {
  if (mask.alpha.empty() ||
      previousMask.alpha.empty() ||
      mask.width == 0u ||
      mask.height == 0u ||
      mask.width != previousMask.width ||
      mask.height != previousMask.height ||
      mask.timestampNs <= previousMask.timestampNs ||
      mask.timestampNs - previousMask.timestampNs > kTemporalAlphaMaxAgeNs) {
    return;
  }

  const std::vector<uint8_t> protectionMask = alphaProtectionMask(mask, kTemporalProtectionRadiusPx);
  const float maxPreviousWeight = maskAgeMs >= kStaleMaskAgeMs ? kStalePreviousWeight : kQuietPreviousWeight;
  const size_t pixelCount = static_cast<size_t>(mask.width) * mask.height;
  for (size_t index = 0; index < pixelCount; ++index) {
    const uint8_t currentAlpha = mask.alpha[index];
    const uint8_t previousAlpha = previousMask.alpha[index];
    if (protectionMask[index] == 0u) {
      continue;
    }
    const float motion = static_cast<float>(std::abs(static_cast<int>(currentAlpha) - static_cast<int>(previousAlpha))) / 255.0f;
    const float previousWeight = lerp(maxPreviousWeight, kMotionPreviousWeight, motion);
    const float currentWeight = 1.0f - previousWeight;
    const float blendedAlpha =
        static_cast<float>(currentAlpha) * currentWeight +
        static_cast<float>(previousAlpha) * previousWeight;
    mask.alpha[index] = static_cast<uint8_t>(std::round(std::clamp(blendedAlpha, 0.0f, 255.0f)));
  }
}

uint32_t dynamicDilationRadius(const KeyerSettings &settings, double maskAgeMs) {
  uint32_t radius = std::min(settings.maskDilatePx, kMaxAlphaDilateRadiusPx);
  if (radius == 0u || !settings.dynamicDilation || maskAgeMs < 0.0) {
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

void postprocessAlpha(AlphaMask &mask,
                      const KeyerSettings &settings,
                      double maskAgeMs,
                      KeyerMetrics &metrics) {
  const auto start = std::chrono::steady_clock::now();
  remapAlphaSmoothstep(mask);
  const auto dilateStart = std::chrono::steady_clock::now();
  dilateAlpha(mask, dynamicDilationRadius(settings, maskAgeMs));
  const auto dilateEnd = std::chrono::steady_clock::now();
  featherAlpha(mask, std::min(settings.maskFeatherPx, kMaxAlphaFeatherRadiusPx));
  const auto end = std::chrono::steady_clock::now();
  metrics.maskDilateMs = elapsedMs(dilateStart, dilateEnd);
  metrics.maskPostprocessMs = elapsedMs(start, end);
}

void applyLatestAlphaToCurrentFrame(const VideoFrame &currentFrame,
                                    const AlphaMask &latestMask,
                                    VideoFrame &outputFrame) {
  outputFrame = currentFrame;
  if (currentFrame.rgba.empty() ||
      latestMask.alpha.empty() ||
      currentFrame.width == 0u ||
      currentFrame.height == 0u ||
      latestMask.width == 0u ||
      latestMask.height == 0u) {
    return;
  }

  std::vector<MaskSample> xSamples(currentFrame.width);
  std::vector<MaskSample> ySamples(currentFrame.height);
  for (uint32_t x = 0; x < currentFrame.width; ++x) {
    const double sourceX = currentFrame.width > 1u
        ? (static_cast<double>(x) * static_cast<double>(latestMask.width - 1u)) / static_cast<double>(currentFrame.width - 1u)
        : 0.0;
    const size_t lower = static_cast<size_t>(std::floor(sourceX));
    xSamples[x].lower = lower;
    xSamples[x].upper = std::min<size_t>(latestMask.width - 1u, lower + 1u);
    xSamples[x].upperWeight = static_cast<uint32_t>(std::round((sourceX - static_cast<double>(lower)) * 256.0));
  }
  for (uint32_t y = 0; y < currentFrame.height; ++y) {
    const double sourceY = currentFrame.height > 1u
        ? (static_cast<double>(y) * static_cast<double>(latestMask.height - 1u)) / static_cast<double>(currentFrame.height - 1u)
        : 0.0;
    const size_t lower = static_cast<size_t>(std::floor(sourceY));
    ySamples[y].lower = lower;
    ySamples[y].upper = std::min<size_t>(latestMask.height - 1u, lower + 1u);
    ySamples[y].upperWeight = static_cast<uint32_t>(std::round((sourceY - static_cast<double>(lower)) * 256.0));
  }

  for (uint32_t y = 0; y < currentFrame.height; ++y) {
    const MaskSample &sampleY = ySamples[y];
    const uint32_t yWeight = sampleY.upperWeight;
    const uint32_t inverseYWeight = 256u - yWeight;
    const uint8_t *row0 = latestMask.alpha.data() + sampleY.lower * latestMask.width;
    const uint8_t *row1 = latestMask.alpha.data() + sampleY.upper * latestMask.width;
    for (uint32_t x = 0; x < currentFrame.width; ++x) {
      const MaskSample &sampleX = xSamples[x];
      const uint32_t xWeight = sampleX.upperWeight;
      const uint32_t inverseXWeight = 256u - xWeight;
      const uint32_t top =
          static_cast<uint32_t>(row0[sampleX.lower]) * inverseXWeight +
          static_cast<uint32_t>(row0[sampleX.upper]) * xWeight;
      const uint32_t bottom =
          static_cast<uint32_t>(row1[sampleX.lower]) * inverseXWeight +
          static_cast<uint32_t>(row1[sampleX.upper]) * xWeight;
      const uint32_t alpha = (top * inverseYWeight + bottom * yWeight + 32768u) >> 16u;
      const size_t frameOffset = (static_cast<size_t>(y) * currentFrame.width + x) * 4u;
      outputFrame.rgba[frameOffset + 3u] = static_cast<uint8_t>(std::min(alpha, 255u));
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

  bool copyLatest(AlphaMask &mask) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hasLatestMask_) {
      return false;
    }
    mask = latestMask_;
    return true;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    ++generation_;
    hasPendingFrame_ = false;
    hasLatestMask_ = false;
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
      AlphaMask previousMask;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (hasLatestMask_) {
          previousMask = latestMask_;
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
      blendAlphaTemporal(keyed.mask, previousMask, maskAgeMs);
      postprocessAlpha(keyed.mask, settings, maskAgeMs, keyed.status.metrics);
      bool shouldPublish = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        shouldPublish = !stopping_ && running_.load() && generation == generation_;
        if (shouldPublish) {
          keyed.status.metrics.droppedFrames = droppedFrames_;
          latestMask_ = std::move(keyed.mask);
          hasLatestMask_ = !latestMask_.alpha.empty();
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
  AlphaMask latestMask_;
  uint64_t generation_ = 0;
  uint64_t pendingGeneration_ = 0;
  uint64_t droppedFrames_ = 0;
  bool hasPendingFrame_ = false;
  bool hasLatestMask_ = false;
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
          AlphaMask latestMask;
          if (keyerWorker.copyLatest(latestMask)) {
            applyLatestAlphaToCurrentFrame(frame, latestMask, keyedFrame);
            frameForCompositor = &keyedFrame;
            {
              std::lock_guard<std::mutex> lock(state.mutex);
              if (frame.timestampNs >= latestMask.timestampNs) {
                state.keyerMetrics.maskAgeMs =
                    static_cast<double>(frame.timestampNs - latestMask.timestampNs) / 1000000.0;
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
