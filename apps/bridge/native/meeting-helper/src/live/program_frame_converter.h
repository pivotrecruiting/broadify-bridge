#pragma once

#include "live_stream/video_frame.h"

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>

namespace broadify::meeting {

struct PreviewFrame;

/**
 * Platform half of the program stream: turns an RGBA program frame from
 * PreviewFrameStore into the frame the platform's hardware encoder takes
 * (macOS: a pooled BGRA CVPixelBuffer for VideoToolbox, Windows: NV12 planes
 * in system memory for the Media Foundation encoder), and tells the worker
 * how that encoder wants to be driven. The portable worker in
 * program_stream.cpp owns one converter and serialises every call; a
 * converter is not thread-safe.
 */
class ProgramFrameConverter {
 public:
  virtual ~ProgramFrameConverter() = default;

  /**
   * Makes the converter hand out `width` x `height` frames: kept when the
   * size is unchanged, rebuilt when the program frame size changed. The size
   * is the one of the program FRAME, never of the encode target. False for an
   * empty size or when the platform refuses the buffers; `failure()` then
   * names the reason.
   */
  virtual bool prepare(uint32_t width, uint32_t height) = 0;
  /** Why prepare() failed, for the stream's `last_error.message`. */
  virtual std::string failure() const = 0;

  /**
   * One conversion pass of `frame` into `out` (buffer, size, pixel format; the
   * caller stamps `captureNs`). Bounded by the prepared geometry: returns
   * false, with nothing to release, when no buffer is free or the frame does
   * not match it. The caller drops the frame, it never blocks.
   */
  virtual bool convert(const PreviewFrame &frame, live::CapturedFrame &out) = 0;
  /** Gives back what convert() put into `frame`, once the encoder has seen it. */
  virtual void release(live::CapturedFrame &frame) = 0;
  /** Drops every buffer; prepare() builds them again. */
  virtual void reset() = 0;

  /**
   * Whether convert() and the encoder calls around it may run while the
   * PreviewFrameStore lock is held. True (VideoToolbox): one short pass
   * straight from the store's frame, the encode itself is asynchronous.
   * False (Media Foundation): the worker copies the frame out and holds the
   * store lock for that copy only, so the pipeline's publish() never waits
   * on the conversion or on a Media Foundation call.
   */
  virtual bool runsUnderStoreLock() const = 0;

  /**
   * Pause before the worker asks the platform again for an encoder with a
   * target whose set-up just failed; another target is tried at once. Zero
   * asks again with every frame (VideoToolbox answers at once); Media
   * Foundation enumerates and activates driver MFTs on a new thread for
   * every attempt.
   */
  virtual std::chrono::milliseconds encoderRetryInterval() const = 0;
};

/** The converter of this platform (defined in the platform's converter source). */
std::unique_ptr<ProgramFrameConverter> createProgramFrameConverter();

}  // namespace broadify::meeting
