#include "pipeline/frame_pipeline_gating.h"

#include <iostream>

using broadify::meeting::PipelineWorkTriggers;
using broadify::meeting::shouldRunFusedKeyerWork;
using broadify::meeting::shouldRunProgramWork;
using broadify::meeting::shouldWriteFramebusFrame;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "frame_pipeline_gating_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
  ok &= expect(!shouldRunProgramWork({}), "idle reused frame does not run");
  ok &= expect(shouldRunProgramWork({true, false, false}), "new camera runs");
  ok &= expect(shouldRunProgramWork({false, true, false}), "program change runs");
  ok &= expect(shouldRunProgramWork({false, false, true}), "graphics change runs");

  ok &= expect(shouldRunFusedKeyerWork({true, false, false}),
               "fused keyer runs on new camera");
  ok &= expect(!shouldRunFusedKeyerWork({false, true, true}),
               "fused keyer does not run on reused camera");

  ok &= expect(!shouldWriteFramebusFrame(false, true, true, true),
               "framebus kill switch blocks writes");
  ok &= expect(!shouldWriteFramebusFrame(true, false, true, true),
               "framebus needs a frame");
  ok &= expect(shouldWriteFramebusFrame(true, true, true, false),
               "framebus writes changed program");
  ok &= expect(shouldWriteFramebusFrame(true, true, false, true),
               "framebus writes heartbeat");
  ok &= expect(!shouldWriteFramebusFrame(true, true, false, false),
               "framebus skips idle non-heartbeat");

  return ok ? 0 : 1;
}
