// Pure pacing logic for the preview encoder setup: after a failure the engine
// must not try the same target again on every frame (on a PC without a
// hardware H.264 encoder that is one hardware-MFT enumeration per frame, under
// the engine mutex), but a changed target or signal is tried at once.
#include "common/encoder_retry_backoff.h"

#include <cstdlib>
#include <iostream>

using namespace broadify::pgm;
using broadify::live::EncodeTarget;

static void fail(const char *m) { std::cerr << "encoder_retry_backoff_test failed: " << m << std::endl; std::exit(1); }

static EncodeTarget target(uint32_t width, uint32_t height, uint32_t fpsNum, uint32_t fpsDen) {
  EncodeTarget t;
  t.width = width;
  t.height = height;
  t.fpsNum = fpsNum;
  t.fpsDen = fpsDen;
  return t;
}

int main() {
  // "A few seconds": long enough to take the load off the capture thread, short enough to recover unattended.
  if (kEncoderRetryIntervalNs < 1'000'000'000ULL || kEncoderRetryIntervalNs > 10'000'000'000ULL) fail("retry interval out of range");

  const EncodeTarget hd30 = target(1920, 1080, 30, 1);
  const uint64_t t0 = 7'000'000'000ULL;

  // Nothing failed: every attempt is due (first frames, working encoder, reconfiguration).
  EncoderRetryBackoff backoff;
  if (!backoff.attemptDue(hd30, 0) || !backoff.attemptDue(hd30, t0) || !backoff.attemptDue(hd30, t0 + 1)) fail("no failure: always due");

  // After a failure the same target waits for the interval, to the nanosecond.
  backoff.onFailure(hd30, t0);
  if (backoff.attemptDue(hd30, t0)) fail("same instant");
  if (backoff.attemptDue(hd30, t0 + 16'666'667ULL)) fail("next frame at 60 fps");
  if (backoff.attemptDue(hd30, t0 + 1'000'000'000ULL)) fail("one second later");
  if (backoff.attemptDue(hd30, t0 + kEncoderRetryIntervalNs - 1)) fail("just before the interval ends");
  if (!backoff.attemptDue(hd30, t0 + kEncoderRetryIntervalNs)) fail("due when the interval has passed");
  if (!backoff.attemptDue(hd30, t0 + 10 * kEncoderRetryIntervalNs)) fail("stays due until the next attempt");

  // What the engine does on a PC without a hardware encoder: a steady 60 fps
  // signal, every due attempt fails again. Over four intervals that is four
  // attempts (the first frame, then one each time the interval has passed),
  // not one per frame.
  {
    EncoderRetryBackoff steady;
    const uint64_t frameNs = 1'000'000'000ULL / 60;
    int frames = 0;
    int attempts = 0;
    for (uint64_t now = t0; now < t0 + 4 * kEncoderRetryIntervalNs; now += frameNs) {
      frames += 1;
      if (steady.attemptDue(hd30, now)) {
        attempts += 1;
        steady.onFailure(hd30, now);
      }
    }
    if (frames < 4 * 60) fail("the simulation must cover seconds of frames");
    if (attempts != 4) fail("one attempt per interval for an unchanged target");
  }

  // A different target is tried at once: each field the engine compares counts.
  if (!backoff.attemptDue(target(1280, 1080, 30, 1), t0 + 1)) fail("width change");
  if (!backoff.attemptDue(target(1920, 720, 30, 1), t0 + 1)) fail("height change");
  if (!backoff.attemptDue(target(1920, 1080, 60, 1), t0 + 1)) fail("frame rate change");
  if (!backoff.attemptDue(target(1920, 1080, 30000, 1001), t0 + 1)) fail("frame rate denominator change");
  // Bitrate and profile name are not part of what the engine reconfigures for.
  EncodeTarget sameGeometry = hd30;
  sameGeometry.bitrateKbps = 2500;
  sameGeometry.profileName = "remote";
  if (backoff.attemptDue(sameGeometry, t0 + 1)) fail("same geometry and rate must wait");

  // The new target failing starts its own interval; only the last failure is remembered.
  const EncodeTarget hd60 = target(1920, 1080, 60, 1);
  const uint64_t t1 = t0 + 500'000'000ULL;
  backoff.onFailure(hd60, t1);
  if (backoff.attemptDue(hd60, t1 + 1'000'000'000ULL)) fail("new target waits after its own failure");
  if (!backoff.attemptDue(hd60, t1 + kEncoderRetryIntervalNs)) fail("new target due after its interval");
  if (!backoff.attemptDue(hd30, t1 + 1)) fail("the earlier target counts as changed again");

  // reset(): encoder configured, signal changed or source cleared. The next attempt runs at once.
  backoff.onFailure(hd30, t1);
  if (backoff.attemptDue(hd30, t1 + 1)) fail("armed before reset");
  backoff.reset();
  if (!backoff.attemptDue(hd30, t1 + 1)) fail("reset must make the attempt due");
  // ... and a failure after it arms the back-off again.
  backoff.onFailure(hd30, t1 + 2);
  if (backoff.attemptDue(hd30, t1 + 3)) fail("failure after reset must wait again");

  // A clock that jumps backwards (never the monotonic clock, but never a dead end either).
  if (!backoff.attemptDue(hd30, t1)) fail("time before the failure must not block");

  std::cout << "encoder_retry_backoff_test passed" << std::endl;
  return 0;
}
