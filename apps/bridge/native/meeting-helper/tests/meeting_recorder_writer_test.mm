// Regression test for the meeting recorder's AVAssetWriter configuration.
//
// Real-world failure (Aug 2026): recordings on builds with periodic movie
// fragments + the ".part" sidecar died ~9-12 s in - the writer flipped to
// Failed at a fragment commit, frames stopped landing on disk while the
// session kept "recording", and stop surfaced a raw NSError. Fragmenting was
// removed in response (see recorder_writer_factory.mm). This test drives the
// exact production writer pipeline (video + interleaved PCM audio, host clock
// session start) across >20 s of media with accelerated timestamps and
// requires every frame to append and the file to finalize - guarding the
// shipped configuration against similar duration-dependent regressions.
//
// Codec cases (ADR-0010): every codec of the recording format is written as a
// short 1080p25 clip through the production factory and worker, and the
// finished file is read back (container brand, sample entry, profile, color
// tags, audio format). Hardware only: a codec without a hardware encoder on
// this machine must be refused with the codec token instead, and the cases
// that need an H.264 writer are skipped there.

#include "recorder/recorder_writer_factory.h"
#include "recorder/meeting_recorder.h"
#include "recorder/recorder_encode_policy.h"
#include "recorder/recorder_video_worker.h"
#include "recorder/recording_probe.h"

#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>

using broadify::meeting::finalizeRecorderWriter;
using broadify::meeting::kRecorderFinalizeTimeoutMs;
using broadify::meeting::kRecordingCodecFormats;
using broadify::meeting::kRecordingCodecUnsupportedError;
using broadify::meeting::makeRecorderWriter;
using broadify::meeting::probeRecordingEncoders;
using broadify::meeting::RecorderFinalizeOutcome;
using broadify::meeting::RecorderFinalizeResult;
using broadify::meeting::RecorderFrameClock;
using broadify::meeting::RecorderVideoWorker;
using broadify::meeting::RecorderWriterBundle;
using broadify::meeting::RecordingAudioCodec;
using broadify::meeting::RecordingCodec;
using broadify::meeting::RecordingCodecFormat;
using broadify::meeting::RecordingContainer;
using broadify::meeting::RecordingProbeResult;
using broadify::meeting::recorderEncoderSpecification;
using broadify::meeting::recorderKeyframeInterval;
using broadify::meeting::recorderSidecarPath;
using broadify::meeting::recorderStartWritingError;
using broadify::meeting::recorderVideoBitrateBps;
using broadify::meeting::recorderVideoDataRateBps;
using broadify::meeting::recordingContainerName;
using broadify::meeting::recordingProbeHasEncoder;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "meeting_recorder_writer_test failed: " << what << std::endl;
  }
  return condition;
}

// Default run: small frames, accelerated timestamps - fast enough for ctest.
// BROADIFY_RECORDER_TEST_REALTIME=1 switches to production geometry, noise
// content and wall-clock pacing for manual diagnosis runs.
const bool kRealtime = []() {
  const char *value = getenv("BROADIFY_RECORDER_TEST_REALTIME");
  return value != nullptr && value[0] == '1';
}();
const uint32_t kWidth = kRealtime ? 1920 : 640;
const uint32_t kHeight = kRealtime ? 1080 : 360;
constexpr uint32_t kFps = 30;
// Longer than any duration the Aug 2026 fragment-era builds ever survived
// (~8 s); crosses every boundary the removed 4 s fragment interval would hit.
constexpr uint32_t kMediaSeconds = 24;
constexpr int32_t kAudioRate = 48000;
constexpr uint32_t kAudioChunkFrames = 1024;

std::string describeStatus(AVAssetWriter *writer) {
  std::string text = "status=" + std::to_string((long)writer.status);
  if (writer.error != nil) {
    const char *desc = [[writer.error description] UTF8String];
    text += " error=";
    text += desc != nullptr ? desc : "<unprintable>";
  }
  return text;
}

// Builds one chunk of silent 16-bit mono PCM as a CMSampleBuffer, mirroring
// what the microphone capture session hands the audio input in production.
CMSampleBufferRef makeSilentAudioChunk(CMAudioFormatDescriptionRef format,
                                       CMTime presentationTime) {
  const size_t byteCount = kAudioChunkFrames * sizeof(int16_t);
  CMBlockBufferRef block = nullptr;
  if (CMBlockBufferCreateWithMemoryBlock(
          kCFAllocatorDefault, nullptr, byteCount, kCFAllocatorDefault,
          nullptr, 0, byteCount, kCMBlockBufferAssureMemoryNowFlag,
          &block) != kCMBlockBufferNoErr ||
      block == nullptr) {
    return nullptr;
  }
  CMBlockBufferFillDataBytes(0, block, 0, byteCount);
  CMSampleBufferRef sample = nullptr;
  const CMSampleTimingInfo timing = {
      CMTimeMake(1, kAudioRate),  // duration per sample
      presentationTime,
      kCMTimeInvalid,
  };
  const OSStatus status = CMSampleBufferCreate(
      kCFAllocatorDefault, block, true, nullptr, nullptr, format,
      kAudioChunkFrames, 1, &timing, 0, nullptr, &sample);
  CFRelease(block);
  if (status != noErr) {
    return nullptr;
  }
  return sample;
}

// PCM format matching the mic capture output the production delegate
// forwards (mono 16-bit 48 kHz). The caller releases it.
CMAudioFormatDescriptionRef makeMicAudioFormat() {
  AudioStreamBasicDescription asbd = {};
  asbd.mSampleRate = kAudioRate;
  asbd.mFormatID = kAudioFormatLinearPCM;
  asbd.mFormatFlags =
      kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
  asbd.mBytesPerPacket = sizeof(int16_t);
  asbd.mFramesPerPacket = 1;
  asbd.mBytesPerFrame = sizeof(int16_t);
  asbd.mChannelsPerFrame = 1;
  asbd.mBitsPerChannel = 16;
  CMAudioFormatDescriptionRef format = nullptr;
  if (CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &asbd, 0, nullptr, 0,
                                     nullptr, nullptr, &format) != noErr) {
    return nullptr;
  }
  return format;
}

// Interleaves silent audio up to targetFrames (in audio samples since the
// session start), like the capture callback does while recording. Returns
// false only when a chunk could not be built.
bool appendSilentAudioUpTo(AVAssetWriterInput *audioInput,
                           CMAudioFormatDescriptionRef format,
                           CMTime sessionStart, uint64_t targetFrames,
                           uint64_t &audioFramesWritten) {
  while (audioFramesWritten < targetFrames) {
    int spins = 0;
    while (!audioInput.isReadyForMoreMediaData && spins < 50000) {
      usleep(100);
      ++spins;
    }
    if (!audioInput.isReadyForMoreMediaData) {
      return true;  // encoder busy; production drops the chunk too
    }
    const CMTime audioPts = CMTimeAdd(
        sessionStart,
        CMTimeMake(static_cast<int64_t>(audioFramesWritten), kAudioRate));
    CMSampleBufferRef chunk = makeSilentAudioChunk(format, audioPts);
    if (!expect(chunk != nullptr, "audio chunk builds")) {
      return false;
    }
    [audioInput appendSampleBuffer:chunk];
    CFRelease(chunk);
    audioFramesWritten += kAudioChunkFrames;
  }
  return true;
}

uint64_t nsForFrame(uint64_t frame, uint32_t fps) {
  return static_cast<uint64_t>(
      std::llround((static_cast<long double>(frame) * 1'000'000'000.0L) /
                   static_cast<long double>(fps)));
}

bool fileExists(const std::string &path) {
  return [[NSFileManager defaultManager]
      fileExistsAtPath:[NSString stringWithUTF8String:path.c_str()]];
}

// Counts the video samples actually stored in a finished file (passthrough
// AVAssetReader, no decode).
int64_t countVideoSamples(const std::string &path) {
  AVURLAsset *asset = [AVURLAsset
      URLAssetWithURL:[NSURL fileURLWithPath:[NSString
                                                 stringWithUTF8String:path.c_str()]]
              options:nil];
  NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
  if ([tracks count] != 1) {
    return -1;
  }
  NSError *error = nil;
  AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:asset error:&error];
  if (reader == nil) {
    return -1;
  }
  AVAssetReaderTrackOutput *output =
      [AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:tracks[0]
                                                 outputSettings:nil];
  [reader addOutput:output];
  if (![reader startReading]) {
    return -1;
  }
  int64_t count = 0;
  while (CMSampleBufferRef sample = [output copyNextSampleBuffer]) {
    // The passthrough reader also yields a few zero-byte sample buffers
    // (encoder/muxer padding without media data); only real samples count.
    if (CMSampleBufferGetNumSamples(sample) > 0 &&
        CMSampleBufferGetTotalSampleSize(sample) > 0) {
      ++count;
    }
    CFRelease(sample);
  }

  return reader.status == AVAssetReaderStatusCompleted ? count : -1;
}

// Field finding (Nov 2026): a recording stopped before any program frame was
// committed left a 0-byte "<name>.mp4.part" behind and the recorder reported
// the opaque AVFoundation finish failure. The finalize step must instead cancel
// the writer, delete the sidecar and report the machine token "no_frames".
bool runNoFramesCase(NSString *dir) {
  bool ok = true;
  const std::string finalPath =
      std::string([dir UTF8String]) + "/no-frames.mp4";
  const std::string sidecarPath = recorderSidecarPath(finalPath);
  auto bundle = makeRecorderWriter(sidecarPath, kWidth, kHeight, kFps, RecordingCodec::H264);
  ok &= expect(bundle.writer != nil, "no-frames: writer builds");
  if (bundle.writer == nil) {
    return false;
  }
  ok &= expect([bundle.writer startWriting], "no-frames: startWriting succeeds");
  [bundle.writer startSessionAtSourceTime:CMClockGetTime(CMClockGetHostTimeClock())];
  const RecorderFinalizeResult result = finalizeRecorderWriter(
      bundle.writer, bundle.videoInput, bundle.audioInput, 0u, sidecarPath,
      finalPath, kRecorderFinalizeTimeoutMs);
  ok &= expect(result.outcome == RecorderFinalizeOutcome::NoFrames,
               ("no-frames: outcome is no_frames (got error=" + result.error + ")")
                   .c_str());
  ok &= expect(result.error == "no_frames",
               "no-frames: error token is the machine-readable no_frames");
  ok &= expect(!fileExists(sidecarPath), "no-frames: the .part sidecar is removed");
  ok &= expect(!fileExists(finalPath), "no-frames: no final file is created");
  ok &= expect(bundle.writer.status != AVAssetWriterStatusCompleted,
               "no-frames: the writer was cancelled, not finished");
  return ok;
}

// Frames appended from a producer thread faster than the worker can encode:
// the mailbox replaces pending frames (reported as dropped), the worker keeps
// the CFR timeline from the producer's capture times, and the finished file
// holds exactly the frames the worker reports as written.
bool runWorkerBurstCase(NSString *dir) {
  bool ok = true;
  const std::string finalPath =
      std::string([dir UTF8String]) + "/worker-burst.mp4";
  const std::string sidecarPath = recorderSidecarPath(finalPath);
  auto bundle = makeRecorderWriter(sidecarPath, kWidth, kHeight, kFps, RecordingCodec::H264);
  ok &= expect(bundle.writer != nil, "worker: writer builds");
  if (bundle.writer == nil) {
    return false;
  }
  ok &= expect([bundle.writer startWriting], "worker: startWriting succeeds");
  const CMTime sessionStart = CMClockGetTime(CMClockGetHostTimeClock());
  [bundle.writer startSessionAtSourceTime:sessionStart];

  RecorderVideoWorker::Config config;
  config.writer = bundle.writer;
  config.videoInput = bundle.videoInput;
  config.videoAdaptor = bundle.videoAdaptor;
  config.sessionStart = sessionStart;
  config.width = kWidth;
  config.height = kHeight;
  config.fps = kFps;
  config.cfrEnabled = true;
  RecorderVideoWorker worker(config);
  worker.start();

  // 20 s of media offered as one burst (no pacing): far more than the
  // encoder keeps up with in real time, so the 2-slot mailbox replaces.
  constexpr uint32_t kBurstFrames = 20u * kFps;
  const size_t frameBytes = static_cast<size_t>(kWidth) * kHeight * 4u;
  std::thread producer([&] {
    std::vector<uint8_t> rgba(frameBytes);
    for (uint32_t frame = 0; frame < kBurstFrames; ++frame) {
      std::memset(rgba.data(), static_cast<int>(frame % 251), frameBytes);
      worker.offer(rgba.data(), kWidth, kHeight, nsForFrame(frame, kFps));
    }
  });
  producer.join();
  // A geometry mismatch is ignored, never queued.
  std::vector<uint8_t> wrongGeometry(16u * 16u * 4u, 0u);
  ok &= expect(!worker.offer(wrongGeometry.data(), 16u, 16u, nsForFrame(kBurstFrames, kFps)),
               "worker: geometry mismatch is rejected");
  worker.stop();
  const RecorderVideoWorker::Counters counters = worker.counters();
  ok &= expect(counters.offered == kBurstFrames,
               "worker: every burst frame was offered");
  ok &= expect(counters.videoFrames > 0u, "worker: frames were written");
  ok &= expect(counters.mailboxReplaced > 0u,
               ("worker: burst replaced pending frames (replaced=" +
                std::to_string(counters.mailboxReplaced) + ")")
                   .c_str());
  ok &= expect(counters.droppedFrames >= counters.mailboxReplaced,
               "worker: dropped_frames includes mailbox replacements");
  ok &= expect(counters.queuedFrames == 0u, "worker: stop() drained the mailbox");
  ok &= expect(worker.lastError().empty(),
               ("worker: no writer error (" + worker.lastError() + ")").c_str());
  std::vector<uint8_t> lateFrame(frameBytes, 0u);
  ok &= expect(!worker.offer(lateFrame.data(), kWidth, kHeight,
                             nsForFrame(kBurstFrames + 1u, kFps)),
               "worker: offer after stop is rejected");

  const RecorderFinalizeResult result = finalizeRecorderWriter(
      bundle.writer, bundle.videoInput, bundle.audioInput, counters.videoFrames,
      sidecarPath, finalPath, kRecorderFinalizeTimeoutMs);
  ok &= expect(result.outcome == RecorderFinalizeOutcome::Completed,
               ("worker: finalize completes (error=" + result.error + ")").c_str());
  ok &= expect(!fileExists(sidecarPath) && fileExists(finalPath),
               "worker: sidecar renamed to the final path");
  const int64_t storedFrames = countVideoSamples(finalPath);
  ok &= expect(storedFrames == static_cast<int64_t>(counters.videoFrames),
               ("worker: file holds the reported frames (file=" +
                std::to_string(storedFrames) + " reported=" +
                std::to_string(counters.videoFrames) + " duplicated=" +
                std::to_string(counters.duplicatedFrames) + " dropped=" +
                std::to_string(counters.droppedFrames) + " replaced=" +
                std::to_string(counters.mailboxReplaced) + " offered=" +
                std::to_string(counters.offered) + ")")
                   .c_str());
  // The CFR grid follows the producer's capture times, so the last written
  // index cannot exceed the last offered capture time's grid position.
  ok &= expect(counters.videoFrames <= kBurstFrames,
               "worker: CFR timeline never runs ahead of the capture times");
  return ok;
}

// Portrait program (engine 1080x1920): the recorder takes the canvas geometry
// as-is - writer, worker and the finished file are all 1080x1920, with the
// bitrate the shared policy yields for that pixel count.
bool runPortraitCase(NSString *dir) {
  bool ok = true;
  constexpr uint32_t kPortraitWidth = 1080;
  constexpr uint32_t kPortraitHeight = 1920;
  const std::string finalPath =
      std::string([dir UTF8String]) + "/portrait.mp4";
  const std::string sidecarPath = recorderSidecarPath(finalPath);
  auto bundle =
      makeRecorderWriter(sidecarPath, kPortraitWidth, kPortraitHeight, kFps,
                         RecordingCodec::H264);
  ok &= expect(bundle.writer != nil,
               ("portrait: writer builds (" + bundle.error + ")").c_str());
  if (bundle.writer == nil) {
    return false;
  }
  NSDictionary *outputSettings = bundle.videoInput.outputSettings;
  ok &= expect([outputSettings[AVVideoWidthKey] unsignedIntValue] ==
                       kPortraitWidth &&
                   [outputSettings[AVVideoHeightKey] unsignedIntValue] ==
                       kPortraitHeight,
               "portrait: writer input is 1080x1920");
  NSDictionary *compression = outputSettings[AVVideoCompressionPropertiesKey];
  ok &= expect([compression[AVVideoAverageBitRateKey] unsignedLongLongValue] ==
                   recorderVideoBitrateBps(kPortraitWidth, kPortraitHeight,
                                           kFps),
               "portrait: bitrate matches recorder policy");
  ok &= expect(recorderVideoBitrateBps(kPortraitWidth, kPortraitHeight, kFps) ==
                   recorderVideoBitrateBps(kPortraitHeight, kPortraitWidth,
                                           kFps),
               "portrait: bitrate equals the 1920x1080 bitrate");
  ok &= expect([bundle.writer startWriting],
               "portrait: startWriting succeeds");
  const CMTime sessionStart = CMClockGetTime(CMClockGetHostTimeClock());
  [bundle.writer startSessionAtSourceTime:sessionStart];

  RecorderVideoWorker::Config config;
  config.writer = bundle.writer;
  config.videoInput = bundle.videoInput;
  config.videoAdaptor = bundle.videoAdaptor;
  config.sessionStart = sessionStart;
  config.width = kPortraitWidth;
  config.height = kPortraitHeight;
  config.fps = kFps;
  config.cfrEnabled = true;
  RecorderVideoWorker worker(config);
  worker.start();

  constexpr uint32_t kPortraitFrames = 2u * kFps;
  const size_t frameBytes =
      static_cast<size_t>(kPortraitWidth) * kPortraitHeight * 4u;
  std::vector<uint8_t> rgba(frameBytes);
  for (uint32_t frame = 0; frame < kPortraitFrames; ++frame) {
    std::memset(rgba.data(), static_cast<int>(40u + frame), frameBytes);
    worker.offer(rgba.data(), kPortraitWidth, kPortraitHeight,
                 nsForFrame(frame, kFps));
  }
  // The landscape geometry of the same pixel count is a mismatch here.
  ok &= expect(!worker.offer(rgba.data(), kPortraitHeight, kPortraitWidth,
                             nsForFrame(kPortraitFrames, kFps)),
               "portrait: a 1920x1080 frame is rejected by a 1080x1920 worker");
  worker.stop();
  const RecorderVideoWorker::Counters counters = worker.counters();
  ok &= expect(counters.videoFrames > 0u, "portrait: frames were written");
  ok &= expect(worker.lastError().empty(),
               ("portrait: no writer error (" + worker.lastError() + ")")
                   .c_str());

  const RecorderFinalizeResult result = finalizeRecorderWriter(
      bundle.writer, bundle.videoInput, bundle.audioInput, counters.videoFrames,
      sidecarPath, finalPath, kRecorderFinalizeTimeoutMs);
  ok &= expect(result.outcome == RecorderFinalizeOutcome::Completed,
               ("portrait: finalize completes (error=" + result.error + ")")
                   .c_str());
  ok &= expect(!fileExists(sidecarPath) && fileExists(finalPath),
               "portrait: sidecar renamed to the final path");
  if (!fileExists(finalPath)) {
    return false;
  }
  AVAsset *asset = [AVAsset
      assetWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:
                                                        finalPath.c_str()]]];
  NSArray<AVAssetTrack *> *videoTracks =
      [asset tracksWithMediaType:AVMediaTypeVideo];
  ok &= expect([videoTracks count] == 1, "portrait: file has one video track");
  if ([videoTracks count] == 1) {
    const CGSize size = videoTracks[0].naturalSize;
    const CGAffineTransform transform = videoTracks[0].preferredTransform;
    ok &= expect(size.width == kPortraitWidth && size.height == kPortraitHeight,
                 ("portrait: encoded track is 1080x1920 (got " +
                  std::to_string(size.width) + "x" +
                  std::to_string(size.height) + ")")
                     .c_str());
    // Real portrait pixels, not a rotated landscape track.
    ok &= expect(transform.a == 1.0 && transform.b == 0.0 &&
                     transform.c == 0.0 && transform.d == 1.0,
                 "portrait: track carries no rotation transform");
  }
  ok &= expect(countVideoSamples(finalPath) ==
                   static_cast<int64_t>(counters.videoFrames),
               "portrait: file holds the reported frames");
  return ok;
}

// The production H.264 writer across >20 s of media (see the file comment).
bool runLongRecordingCase(NSString *dir) {
  bool ok = true;
  const std::string finalPath =
      std::string([dir UTF8String]) + "/recording.mp4";
  const std::string sidecarPath = recorderSidecarPath(finalPath);

  auto bundle = makeRecorderWriter(sidecarPath, kWidth, kHeight, kFps,
                                   RecordingCodec::H264);
  ok &= expect(bundle.writer != nil,
               ("writer builds (" + bundle.error + ")").c_str());
  if (bundle.writer == nil) {
    return false;
  }
  NSDictionary *outputSettings = bundle.videoInput.outputSettings;
  NSDictionary *compression =
      outputSettings[AVVideoCompressionPropertiesKey];
  NSNumber *bitrate = compression[AVVideoAverageBitRateKey];
  ok &= expect([bitrate unsignedLongLongValue] ==
                   recorderVideoBitrateBps(kWidth, kHeight, kFps),
               "video bitrate matches recorder policy");
  ok &= expect([compression[AVVideoExpectedSourceFrameRateKey]
                   unsignedIntValue] == kFps,
               "expected source frame rate is set");
  ok &= expect([compression[AVVideoMaxKeyFrameIntervalKey]
                   unsignedIntValue] == recorderKeyframeInterval(kFps),
               "keyframe interval matches recorder policy");
  ok &= expect([compression[AVVideoAllowFrameReorderingKey] boolValue] == NO,
               "frame reordering is disabled");
  ok &= expect([compression[AVVideoH264EntropyModeKey]
                   isEqualToString:AVVideoH264EntropyModeCABAC],
               "CABAC entropy mode is set");
  NSDictionary *colorProperties = outputSettings[AVVideoColorPropertiesKey];
  ok &= expect(colorProperties != nil, "BT.709 color properties exist");
  ok &= expect([colorProperties[AVVideoColorPrimariesKey]
                   isEqualToString:AVVideoColorPrimaries_ITU_R_709_2],
               "BT.709 color primaries are set");
  ok &= expect([colorProperties[AVVideoTransferFunctionKey]
                   isEqualToString:AVVideoTransferFunction_ITU_R_709_2],
               "BT.709 transfer function is set");
  ok &= expect([colorProperties[AVVideoYCbCrMatrixKey]
                   isEqualToString:AVVideoYCbCrMatrix_ITU_R_709_2],
               "BT.709 YCbCr matrix is set");

  CMAudioFormatDescriptionRef audioFormat = makeMicAudioFormat();
  ok &= expect(audioFormat != nullptr, "audio format description builds");
  if (audioFormat == nullptr) {
    return false;
  }

  ok &= expect([bundle.writer startWriting], "startWriting succeeds");
  // Production stamps media on the host clock, not from zero.
  const CMTime sessionStart = CMClockGetTime(CMClockGetHostTimeClock());
  [bundle.writer startSessionAtSourceTime:sessionStart];

  const uint32_t totalFrames = kMediaSeconds * kFps;
  uint32_t appendedFrames = 0;
  uint64_t audioFramesWritten = 0;
  int64_t firstFailureFrame = -1;
  RecorderFrameClock frameClock(kFps);
  for (uint32_t frame = 0; frame < totalFrames; ++frame) {
    const RecorderFrameClock::Plan plan =
        frameClock.plan(nsForFrame(frame, kFps));
    if (!expect(plan.count == 1 && plan.firstIndex == frame &&
                    !plan.discontinuity,
                "frame clock emits one on-grid frame")) {
      ok = false;
      break;
    }
    const CMTime framePts = CMTimeAdd(
        sessionStart,
        CMTimeMake(static_cast<int64_t>(plan.firstIndex) * kAudioRate / kFps,
                   kAudioRate));

    // Interleave silent audio up to the video frame's timestamp.
    ok &= appendSilentAudioUpTo(
        bundle.audioInput, audioFormat, sessionStart,
        static_cast<uint64_t>(frame) * kAudioRate / kFps,
        audioFramesWritten);

    int spins = 0;
    while (!bundle.videoInput.isReadyForMoreMediaData && spins < 50000) {
      usleep(100);
      ++spins;
    }
    if (bundle.writer.status != AVAssetWriterStatusWriting) {
      firstFailureFrame = frame;
      break;
    }
    CVPixelBufferRef pixelBuffer = nullptr;
    CVPixelBufferPoolRef pool = bundle.videoAdaptor.pixelBufferPool;
    if (!expect(pool != nullptr, "pixel buffer pool exists")) {
      ok = false;
      break;
    }
    if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool,
                                           &pixelBuffer) !=
            kCVReturnSuccess ||
        pixelBuffer == nullptr) {
      ok &= expect(false, "pixel buffer allocates");
      break;
    }
    CVPixelBufferLockBaseAddress(pixelBuffer, 0);
    uint8_t *base =
        static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixelBuffer));
    const size_t bytes = CVPixelBufferGetBytesPerRow(pixelBuffer) * kHeight;
    if (kRealtime) {
      // Incompressible noise keeps the encoder at the real bitrate cap.
      uint32_t seed = frame * 2654435761u + 12345u;
      for (size_t i = 0; i < bytes; i += 4) {
        seed = seed * 1664525u + 1013904223u;
        base[i] = static_cast<uint8_t>(seed >> 24);
      }
    } else {
      // Vary the content per frame so the encoder produces real output.
      std::memset(base, static_cast<int>(frame % 251), bytes);
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);

    if ([bundle.videoAdaptor appendPixelBuffer:pixelBuffer
                          withPresentationTime:framePts]) {
      ++appendedFrames;
      frameClock.commit(1);
    } else if (firstFailureFrame < 0) {
      firstFailureFrame = frame;
      CVPixelBufferRelease(pixelBuffer);
      break;
    }
    CVPixelBufferRelease(pixelBuffer);
    if (kRealtime) {
      usleep(1000000 / kFps);
    }
  }

  if (firstFailureFrame >= 0) {
    std::cerr << "meeting_recorder_writer_test: writer stopped accepting at "
              << "media time "
              << (static_cast<double>(firstFailureFrame) / kFps) << " s ("
              << describeStatus(bundle.writer) << ")" << std::endl;
  }
  ok &= expect(appendedFrames == totalFrames,
               "all frames append across the full duration");

  [bundle.videoInput markAsFinished];
  [bundle.audioInput markAsFinished];
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [bundle.writer finishWritingWithCompletionHandler:^{
    dispatch_semaphore_signal(sem);
  }];
  const long timedOut = dispatch_semaphore_wait(
      sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)));
  ok &= expect(timedOut == 0, "finishWriting completes within 30 s");
  ok &= expect(bundle.writer.status == AVAssetWriterStatusCompleted,
               ("finishWriting reports Completed (" +
                describeStatus(bundle.writer) + ")")
                   .c_str());
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *sidecar = [NSString stringWithUTF8String:sidecarPath.c_str()];
  NSString *final = [NSString stringWithUTF8String:finalPath.c_str()];
  [fm removeItemAtPath:final error:nil];
  NSError *renameError = nil;
  ok &= expect([fm moveItemAtPath:sidecar toPath:final error:&renameError],
               "sidecar renames to final mp4 path");
  AVAsset *asset = [AVAsset
      assetWithURL:[NSURL fileURLWithPath:[NSString
                                              stringWithUTF8String:
                                                  finalPath.c_str()]]];
  NSArray<AVAssetTrack *> *videoTracks =
      [asset tracksWithMediaType:AVMediaTypeVideo];
  ok &= expect([videoTracks count] == 1, "encoded file has one video track");
  if ([videoTracks count] == 1) {
    const float nominalFrameRate = videoTracks[0].nominalFrameRate;
    ok &= expect(std::fabs(nominalFrameRate - static_cast<float>(kFps)) <=
                     0.05f,
                 "encoded file reports 30 fps nominal frame rate");
  }
  CFRelease(audioFormat);

  NSDictionary *attrs = [fm attributesOfItemAtPath:final error:nil];
  // Silence + flat synthetic frames compress to well under production
  // bitrates; the floor only guards against an empty/headers-only file.
  const unsigned long long size = attrs != nil ? [attrs fileSize] : 0ull;
  if (!expect(size > 20000ull, "final file holds the encoded media")) {
    ok = false;
    std::cerr << "meeting_recorder_writer_test: final size=" << size
              << " path=" << finalPath << std::endl;
  }
  return ok;
}

// FourCC of a track's sample entry as text ("avc1", "hvc1", "apcn", "lpcm").
std::string fourCcText(FourCharCode code) {
  const char text[5] = {static_cast<char>(code >> 24),
                        static_cast<char>(code >> 16),
                        static_cast<char>(code >> 8), static_cast<char>(code),
                        '\0'};
  return text;
}

// Major brand of the file type box: "mp42" for an MPEG-4 file, "qt  " for a
// QuickTime movie.
std::string majorBrand(const std::string &path) {
  NSFileHandle *handle = [NSFileHandle
      fileHandleForReadingAtPath:[NSString stringWithUTF8String:path.c_str()]];
  NSData *head = [handle readDataOfLength:12];
  if ([head length] < 12 ||
      std::memcmp(static_cast<const char *>([head bytes]) + 4, "ftyp", 4) != 0) {
    return {};
  }
  return std::string(static_cast<const char *>([head bytes]) + 8, 4);
}

struct CodecExpectation {
  const char *videoSampleEntry;
  // Decoder configuration box and the profile it must name (avcC: profile_idc
  // 100 = High; hvcC: general_profile_idc 1 = Main); nullptr for ProRes.
  const char *configurationAtom;
  uint8_t profile;
};

CodecExpectation codecExpectation(RecordingCodec codec) {
  switch (codec) {
    case RecordingCodec::H264:
      break;
    case RecordingCodec::Hevc:
      return {"hvc1", "hvcC", 1};
    case RecordingCodec::ProRes422Lt:
      return {"apcs", nullptr, 0};
    case RecordingCodec::ProRes422:
      return {"apcn", nullptr, 0};
    case RecordingCodec::ProRes422Hq:
      return {"apch", nullptr, 0};
  }
  return {"avc1", "avcC", 100};
}

// One codec of the recording format, end to end: factory settings, a short
// 1080p25 clip through the production worker with interleaved microphone
// audio, finalize, and the finished file read back. Without a hardware
// encoder for the codec the factory must refuse it instead.
bool runCodecCase(NSString *dir, const RecordingCodecFormat &format,
                  bool hasHardwareEncoder) {
  bool ok = true;
  constexpr uint32_t kCodecWidth = 1920;
  constexpr uint32_t kCodecHeight = 1080;
  constexpr uint32_t kCodecFps = 25;
  constexpr uint32_t kCodecFrames = 2u * kCodecFps;
  const std::string name = format.name;
  const auto label = [&name](const char *what) { return name + ": " + what; };
  const std::string finalPath = std::string([dir UTF8String]) + "/codec-" +
                                name + "." +
                                recordingContainerName(format.container);
  const std::string sidecarPath = recorderSidecarPath(finalPath);
  RecorderWriterBundle bundle = makeRecorderWriter(
      sidecarPath, kCodecWidth, kCodecHeight, kCodecFps, format.codec);

  if (!hasHardwareEncoder) {
    ok &= expect(bundle.writer == nil &&
                     bundle.error == kRecordingCodecUnsupportedError,
                 label("refused without a hardware encoder").c_str());
    ok &= expect(!fileExists(sidecarPath),
                 label("a refused codec creates no file").c_str());
    std::cout << "meeting_recorder_writer_test: " << name
              << " has no hardware encoder here, refusal verified" << std::endl;
    return ok;
  }

  ok &= expect(bundle.writer != nil,
               label(("writer builds (" + bundle.error + ")").c_str()).c_str());
  if (bundle.writer == nil) {
    return false;
  }
  NSDictionary *videoSettings = bundle.videoInput.outputSettings;
  NSDictionary *specification = videoSettings[AVVideoEncoderSpecificationKey];
  ok &= expect(
      [specification[(__bridge NSString *)
                         kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder]
          boolValue],
      label("a hardware encoder is required").c_str());
  NSDictionary *colorProperties = videoSettings[AVVideoColorPropertiesKey];
  ok &= expect([colorProperties[AVVideoColorPrimariesKey]
                       isEqualToString:AVVideoColorPrimaries_ITU_R_709_2] &&
                   [colorProperties[AVVideoTransferFunctionKey]
                       isEqualToString:AVVideoTransferFunction_ITU_R_709_2] &&
                   [colorProperties[AVVideoYCbCrMatrixKey]
                       isEqualToString:AVVideoYCbCrMatrix_ITU_R_709_2],
               label("BT.709 color properties are set").c_str());
  NSDictionary *compression = videoSettings[AVVideoCompressionPropertiesKey];
  if (format.audio == RecordingAudioCodec::Pcm) {
    // ProRes: quality driven, no bitrate or GOP to configure.
    ok &= expect(compression == nil,
                 label("ProRes carries no compression properties").c_str());
  } else {
    ok &= expect([compression[AVVideoAverageBitRateKey] unsignedLongLongValue] ==
                     recorderVideoDataRateBps(format.codec, kCodecWidth,
                                              kCodecHeight, kCodecFps),
                 label("bitrate matches the codec policy").c_str());
    ok &= expect([compression[AVVideoMaxKeyFrameIntervalKey] unsignedIntValue] ==
                     recorderKeyframeInterval(kCodecFps),
                 label("keyframe interval matches recorder policy").c_str());
    ok &= expect([compression[AVVideoAllowFrameReorderingKey] boolValue] == NO,
                 label("frame reordering is disabled").c_str());
  }
  ok &= expect([bundle.audioInput.outputSettings[AVFormatIDKey]
                       unsignedIntValue] ==
                   (format.audio == RecordingAudioCodec::Pcm
                        ? kAudioFormatLinearPCM
                        : kAudioFormatMPEG4AAC),
               label("audio format follows the codec table").c_str());

  CMAudioFormatDescriptionRef audioFormat = makeMicAudioFormat();
  ok &= expect(audioFormat != nullptr,
               label("audio format description builds").c_str());
  if (audioFormat == nullptr) {
    return false;
  }
  const bool started = [bundle.writer startWriting];
  ok &= expect(started,
               label(("startWriting succeeds (" +
                      recorderStartWritingError(bundle.writer.error) + ")")
                         .c_str())
                   .c_str());
  if (!started) {
    CFRelease(audioFormat);
    return false;
  }
  const CMTime sessionStart = CMClockGetTime(CMClockGetHostTimeClock());
  [bundle.writer startSessionAtSourceTime:sessionStart];

  RecorderVideoWorker::Config config;
  config.writer = bundle.writer;
  config.videoInput = bundle.videoInput;
  config.videoAdaptor = bundle.videoAdaptor;
  config.sessionStart = sessionStart;
  config.width = kCodecWidth;
  config.height = kCodecHeight;
  config.fps = kCodecFps;
  config.cfrEnabled = true;
  RecorderVideoWorker worker(config);
  worker.start();

  const size_t frameBytes =
      static_cast<size_t>(kCodecWidth) * kCodecHeight * 4u;
  std::vector<uint8_t> rgba(frameBytes);
  uint64_t audioFramesWritten = 0;
  for (uint32_t frame = 0; frame < kCodecFrames; ++frame) {
    ok &= appendSilentAudioUpTo(
        bundle.audioInput, audioFormat, sessionStart,
        static_cast<uint64_t>(frame) * kAudioRate / kCodecFps,
        audioFramesWritten);
    std::memset(rgba.data(), static_cast<int>(40u + frame * 3u), frameBytes);
    worker.offer(rgba.data(), kCodecWidth, kCodecHeight,
                 nsForFrame(frame, kCodecFps));
    // Paced on the worker instead of the wall clock: the next frame is
    // offered once the mailbox is empty, so none is replaced.
    for (int spins = 0;
         worker.counters().queuedFrames > 0u && spins < 50000; ++spins) {
      usleep(100);
    }
  }
  worker.stop();
  CFRelease(audioFormat);
  const RecorderVideoWorker::Counters counters = worker.counters();
  ok &= expect(counters.videoFrames > 0u, label("frames were written").c_str());
  ok &= expect(worker.lastError().empty(),
               label(("no writer error (" + worker.lastError() + ")").c_str())
                   .c_str());

  const RecorderFinalizeResult result = finalizeRecorderWriter(
      bundle.writer, bundle.videoInput, bundle.audioInput, counters.videoFrames,
      sidecarPath, finalPath, kRecorderFinalizeTimeoutMs);
  ok &= expect(result.outcome == RecorderFinalizeOutcome::Completed,
               label(("finalize completes (error=" + result.error + ")").c_str())
                   .c_str());
  ok &= expect(!fileExists(sidecarPath) && fileExists(finalPath),
               label("sidecar renamed to the final path").c_str());
  if (!fileExists(finalPath)) {
    return false;
  }

  // Read the finished file back.
  const std::string brand = majorBrand(finalPath);
  ok &= expect(brand == (format.container == RecordingContainer::Mov ? "qt  "
                                                                     : "mp42"),
               label(("container brand (got '" + brand + "')").c_str()).c_str());
  AVAsset *asset = [AVAsset
      assetWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:
                                                        finalPath.c_str()]]];
  NSArray<AVAssetTrack *> *videoTracks =
      [asset tracksWithMediaType:AVMediaTypeVideo];
  NSArray<AVAssetTrack *> *audioTracks =
      [asset tracksWithMediaType:AVMediaTypeAudio];
  ok &= expect([videoTracks count] == 1 && [audioTracks count] == 1,
               label("file has one video and one audio track").c_str());
  if ([videoTracks count] != 1 || [audioTracks count] != 1) {
    return false;
  }
  const CodecExpectation expected = codecExpectation(format.codec);
  CMFormatDescriptionRef videoDescription =
      (__bridge CMFormatDescriptionRef)videoTracks[0].formatDescriptions[0];
  const std::string sampleEntry =
      fourCcText(CMFormatDescriptionGetMediaSubType(videoDescription));
  ok &= expect(sampleEntry == expected.videoSampleEntry,
               label(("video sample entry (got '" + sampleEntry + "')").c_str())
                   .c_str());
  if (expected.configurationAtom != nullptr) {
    NSDictionary *atoms = (__bridge NSDictionary *)CMFormatDescriptionGetExtension(
        videoDescription,
        kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms);
    NSData *configuration =
        atoms[[NSString stringWithUTF8String:expected.configurationAtom]];
    // Byte 1 of avcC is profile_idc; the low five bits of byte 1 of hvcC are
    // general_profile_idc.
    const uint8_t profile =
        [configuration length] > 1
            ? static_cast<const uint8_t *>([configuration bytes])[1] & 0x7Fu
            : 0u;
    ok &= expect((format.codec == RecordingCodec::Hevc ? profile & 0x1Fu
                                                       : profile) ==
                     expected.profile,
                 label(("profile (got " + std::to_string(profile) + ")").c_str())
                     .c_str());
  }
  const CMVideoDimensions dimensions =
      CMVideoFormatDescriptionGetDimensions(videoDescription);
  ok &= expect(dimensions.width == static_cast<int32_t>(kCodecWidth) &&
                   dimensions.height == static_cast<int32_t>(kCodecHeight),
               label("encoded track is 1920x1080").c_str());
  ok &= expect(std::fabs(videoTracks[0].nominalFrameRate -
                         static_cast<float>(kCodecFps)) <= 0.5f,
               label("nominal frame rate is 25 fps").c_str());
  const auto hasColorTag = [videoDescription](CFStringRef key,
                                              CFStringRef value) {
    CFTypeRef tag = CMFormatDescriptionGetExtension(videoDescription, key);
    return tag != nullptr && CFEqual(tag, value);
  };
  ok &= expect(hasColorTag(kCMFormatDescriptionExtension_ColorPrimaries,
                           kCMFormatDescriptionColorPrimaries_ITU_R_709_2) &&
                   hasColorTag(kCMFormatDescriptionExtension_TransferFunction,
                               kCMFormatDescriptionTransferFunction_ITU_R_709_2) &&
                   hasColorTag(kCMFormatDescriptionExtension_YCbCrMatrix,
                               kCMFormatDescriptionYCbCrMatrix_ITU_R_709_2),
               label("file is tagged BT.709").c_str());
  ok &= expect(countVideoSamples(finalPath) ==
                   static_cast<int64_t>(counters.videoFrames),
               label("file holds the reported frames").c_str());

  CMAudioFormatDescriptionRef audioDescription =
      (__bridge CMAudioFormatDescriptionRef)audioTracks[0].formatDescriptions[0];
  const AudioStreamBasicDescription *audio =
      CMAudioFormatDescriptionGetStreamBasicDescription(audioDescription);
  ok &= expect(audio != nullptr, label("audio description is readable").c_str());
  if (audio != nullptr) {
    if (format.audio == RecordingAudioCodec::Pcm) {
      ok &= expect(audio->mFormatID == kAudioFormatLinearPCM &&
                       audio->mBitsPerChannel == 24u,
                   label("audio is 24-bit PCM").c_str());
    } else {
      ok &= expect(audio->mFormatID == kAudioFormatMPEG4AAC,
                   label("audio is AAC").c_str());
    }
    ok &= expect(audio->mSampleRate == 48000.0 && audio->mChannelsPerFrame == 1u,
                 label("audio is mono 48 kHz").c_str());
  }
  return ok;
}

// The hardware-only doctrine rests on AVAssetWriter evaluating the encoder
// specification. Proven on a machine that HAS hardware encoders by taking
// the production video settings and additionally forbidding hardware: the
// requirement can then not be met, startWriting must fail instead of falling
// back to a software encoder, and the failure maps to the codec token.
bool runHardwareRequirementCase(NSString *dir) {
  bool ok = true;
  for (const RecordingCodecFormat &format : kRecordingCodecFormats) {
    const std::string name = format.name;
    const std::string path = std::string([dir UTF8String]) + "/no-hardware-" +
                             name + "." +
                             recordingContainerName(format.container);
    RecorderWriterBundle bundle =
        makeRecorderWriter(path, 1920, 1080, 25, format.codec);
    if (bundle.writer == nil) {
      continue;  // no hardware encoder: the refusal is runCodecCase's subject
    }
    NSMutableDictionary *settings = [bundle.videoInput.outputSettings mutableCopy];
    NSMutableDictionary *specification = [recorderEncoderSpecification() mutableCopy];
    specification[(__bridge NSString *)
                      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder] =
        @NO;
    settings[AVVideoEncoderSpecificationKey] = specification;
    AVAssetWriter *writer = [AVAssetWriter
        assetWriterWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:
                                                                path.c_str()]]
                  fileType:bundle.writer.outputFileType
                     error:nil];
    AVAssetWriterInput *input =
        [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                           outputSettings:settings];
    ok &= expect(writer != nil && [writer canAddInput:input],
                 (name + ": hardware-forbidden writer builds").c_str());
    if (writer == nil || ![writer canAddInput:input]) {
      continue;
    }
    [writer addInput:input];
    const bool started = [writer startWriting];
    ok &= expect(!started,
                 (name + ": no software fallback when hardware is unavailable")
                     .c_str());
    ok &= expect(recorderStartWritingError(writer.error) ==
                     kRecordingCodecUnsupportedError,
                 (name + ": the failure is the codec token (got " +
                  recorderStartWritingError(writer.error) + ")")
                     .c_str());
    if (started) {
      [writer cancelWriting];
    }
  }
  return ok;
}

}  // namespace

int main() {
  bool ok = true;

  @autoreleasepool {
    // BROADIFY_RECORDER_TEST_DIR overrides the output location for manual
    // diagnosis runs (e.g. a TCC-protected folder like ~/Downloads).
    const char *dirOverride = getenv("BROADIFY_RECORDER_TEST_DIR");
    NSString *baseDir =
        dirOverride != nullptr && dirOverride[0] != '\0'
            ? [NSString stringWithUTF8String:dirOverride]
            : NSTemporaryDirectory();
    NSString *dir = [baseDir
        stringByAppendingPathComponent:
            [NSString stringWithFormat:@"broadify-recorder-test-%d", getpid()]];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    const RecordingProbeResult probe = probeRecordingEncoders();
    ok &= expect(probe.ok, "VideoToolbox encoder enumeration succeeds");
    for (const RecordingCodecFormat &format : kRecordingCodecFormats) {
      ok &= runCodecCase(dir, format,
                         recordingProbeHasEncoder(probe, format.codec));
    }
    ok &= runHardwareRequirementCase(dir);

    if (recordingProbeHasEncoder(probe, RecordingCodec::H264)) {
      ok &= runLongRecordingCase(dir);
      ok &= runNoFramesCase(dir);
      ok &= runWorkerBurstCase(dir);
      ok &= runPortraitCase(dir);
    } else {
      std::cout << "meeting_recorder_writer_test: no hardware H.264 encoder on "
                   "this machine, the H.264 writer cases are skipped"
                << std::endl;
    }

    // BROADIFY_RECORDER_TEST_KEEP=1 leaves the written files in place for a
    // manual look (ffprobe, QuickTime Player).
    const char *keep = getenv("BROADIFY_RECORDER_TEST_KEEP");
    if (keep != nullptr && keep[0] == '1') {
      std::cout << "meeting_recorder_writer_test: files kept in "
                << [dir UTF8String] << std::endl;
    } else {
      [[NSFileManager defaultManager] removeItemAtPath:dir error:nil];
    }
  }

  if (!ok) {
    return 1;
  }
  std::cout << "meeting_recorder_writer_test passed" << std::endl;
  return 0;
}
