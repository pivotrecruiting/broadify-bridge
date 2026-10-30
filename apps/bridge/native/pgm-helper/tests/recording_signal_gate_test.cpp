// Pure decision logic for the PGM recording encoder: which captured frames
// reach it while the source signal drifts from the geometry the recording
// started with (Gabriel, 2026-10-30: a signal change is a gap, the file stays
// valid), plus the preview gate that must no longer depend on the recorder.
#include "recorder/recording_signal_gate.h"

#include <cstdlib>
#include <iostream>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "recording_signal_gate_test failed: " << m << std::endl; std::exit(1); }

int main() {
  RecordingSignalGate gate;
  if (gate.armed()) fail("gate starts disarmed");
  // Disarmed: nothing is encoded, nothing is reported.
  RecordingGateDecision d = gate.onFrame(1920, 1080, "nv12");
  if (d.encode || d.forceKeyframe || d.mismatchStarted || d.mismatchEnded) fail("disarmed gate must not encode");

  gate.arm(1920, 1080, "nv12", 30, 1);
  if (!gate.armed() || gate.mismatched()) fail("armed gate starts matched");

  // Matching geometry: encode, no keyframe request beyond the encoder's own first IDR.
  d = gate.onFrame(1920, 1080, "nv12");
  if (!d.encode || d.forceKeyframe || d.mismatchStarted || d.mismatchEnded) fail("matching frame must encode");

  // Geometry change: the frame is skipped and the mismatch episode starts exactly once.
  d = gate.onFrame(1280, 720, "nv12");
  if (d.encode || !d.mismatchStarted || d.mismatchEnded) fail("geometry change must skip and report mismatch start");
  if (!gate.mismatched()) fail("gate must remember the mismatch");
  d = gate.onFrame(1280, 720, "nv12");
  if (d.encode || d.mismatchStarted || d.mismatchEnded) fail("mismatch must be reported only once per episode");
  // A pixel-format change counts as geometry too (the encoder session is bound to NV12).
  d = gate.onFrame(1920, 1080, "uyvy");
  if (d.encode || d.mismatchStarted) fail("pixel format change must keep skipping");

  // Return of the start geometry: encode again with a forced keyframe (the file resumes on an IDR).
  d = gate.onFrame(1920, 1080, "nv12");
  if (!d.encode || !d.forceKeyframe || !d.mismatchEnded || d.mismatchStarted) fail("return must encode with a keyframe and end the episode");
  if (gate.mismatched()) fail("gate must be matched again");
  d = gate.onFrame(1920, 1080, "nv12");
  if (!d.encode || d.forceKeyframe || d.mismatchEnded) fail("steady state after return");

  // Second episode starts fresh.
  d = gate.onFrame(1280, 720, "nv12");
  if (d.encode || !d.mismatchStarted) fail("second episode must be reported again");

  // Frame-rate-only change: tolerated (the encoder keeps its clock from PTS), only reported for the log.
  RecordingSignalGate fpsGate;
  fpsGate.arm(1920, 1080, "nv12", 30, 1);
  if (fpsGate.fpsChanged(30, 1)) fail("same fps is not a change");
  if (!fpsGate.fpsChanged(25, 1)) fail("fps change must be reported for the log");
  if (fpsGate.fpsChanged(25, 1)) fail("fps change is reported once");
  d = fpsGate.onFrame(1920, 1080, "nv12");
  if (!d.encode || d.mismatchStarted) fail("fps-only change must keep encoding");

  // reset() disarms: a stale decision after recordingStop must not reach a destroyed encoder.
  fpsGate.reset();
  if (fpsGate.armed()) fail("reset must disarm");
  d = fpsGate.onFrame(1920, 1080, "nv12");
  if (d.encode) fail("disarmed after reset");

  // Preview gate: viewers only, never the recorder (the recording has its own encoder now).
  if (RecordingSignalGate::shouldEncodePreview(0, true)) fail("no viewers: no preview encode");
  if (!RecordingSignalGate::shouldEncodePreview(1, true)) fail("one viewer: preview encode");
  if (RecordingSignalGate::shouldEncodePreview(1, false)) fail("unconfigured encoder: no preview encode");

  std::cout << "recording_signal_gate_test passed" << std::endl;
  return 0;
}
