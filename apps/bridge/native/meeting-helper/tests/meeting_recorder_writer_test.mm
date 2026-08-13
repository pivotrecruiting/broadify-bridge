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

#include "recorder/recorder_writer_factory.h"

#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <unistd.h>

using broadify::meeting::makeRecorderWriter;
using broadify::meeting::recorderSidecarPath;

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
    const std::string finalPath =
        std::string([dir UTF8String]) + "/recording.mp4";
    const std::string sidecarPath = recorderSidecarPath(finalPath);

    auto bundle = makeRecorderWriter(sidecarPath, kWidth, kHeight, kFps);
    ok &= expect(bundle.writer != nil,
                 ("writer builds (" + bundle.error + ")").c_str());
    if (bundle.writer == nil) {
      return 1;
    }

    // PCM format matching the mic capture output the production delegate
    // forwards (mono 16-bit 48 kHz).
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
    CMAudioFormatDescriptionRef audioFormat = nullptr;
    ok &= expect(CMAudioFormatDescriptionCreate(
                     kCFAllocatorDefault, &asbd, 0, nullptr, 0, nullptr,
                     nullptr, &audioFormat) == noErr,
                 "audio format description builds");
    if (audioFormat == nullptr) {
      return 1;
    }

    ok &= expect([bundle.writer startWriting], "startWriting succeeds");
    // Production stamps media on the host clock, not from zero.
    const CMTime sessionStart = CMClockGetTime(CMClockGetHostTimeClock());
    [bundle.writer startSessionAtSourceTime:sessionStart];

    const uint32_t totalFrames = kMediaSeconds * kFps;
    uint32_t appendedFrames = 0;
    uint64_t audioFramesWritten = 0;
    int64_t firstFailureFrame = -1;
    for (uint32_t frame = 0; frame < totalFrames; ++frame) {
      const CMTime framePts = CMTimeAdd(
          sessionStart,
          CMTimeMake(static_cast<int64_t>(frame) * kAudioRate / kFps,
                     kAudioRate));

      // Interleave silent audio up to the video frame's timestamp, like the
      // capture callback does while recording.
      while (audioFramesWritten <
             static_cast<uint64_t>(frame) * kAudioRate / kFps) {
        int spins = 0;
        while (!bundle.audioInput.isReadyForMoreMediaData && spins < 50000) {
          usleep(100);
          ++spins;
        }
        if (!bundle.audioInput.isReadyForMoreMediaData) {
          break;  // encoder busy; production drops the chunk too
        }
        const CMTime audioPts = CMTimeAdd(
            sessionStart,
            CMTimeMake(static_cast<int64_t>(audioFramesWritten), kAudioRate));
        CMSampleBufferRef chunk = makeSilentAudioChunk(audioFormat, audioPts);
        if (!expect(chunk != nullptr, "audio chunk builds")) {
          ok = false;
          break;
        }
        [bundle.audioInput appendSampleBuffer:chunk];
        CFRelease(chunk);
        audioFramesWritten += kAudioChunkFrames;
      }

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
    CFRelease(audioFormat);

    NSDictionary *attrs = [[NSFileManager defaultManager]
        attributesOfItemAtPath:[NSString
                                   stringWithUTF8String:sidecarPath.c_str()]
                         error:nil];
    // Silence + flat synthetic frames compress to well under production
    // bitrates; the floor only guards against an empty/headers-only file.
    const unsigned long long size = attrs != nil ? [attrs fileSize] : 0ull;
    if (!expect(size > 20000ull, "sidecar file holds the encoded media")) {
      ok = false;
      std::cerr << "meeting_recorder_writer_test: sidecar size=" << size
                << " path=" << sidecarPath << std::endl;
    }

    [[NSFileManager defaultManager] removeItemAtPath:dir error:nil];
  }

  if (!ok) {
    return 1;
  }
  std::cout << "meeting_recorder_writer_test passed" << std::endl;
  return 0;
}
