#include "pipeline/frame_pipeline_gating.h"

namespace broadify::meeting {

bool shouldRunProgramWork(const PipelineWorkTriggers &triggers) {
  return triggers.hasNewCameraFrame || triggers.programChanged ||
         triggers.graphicsChanged;
}

bool shouldRunFusedKeyerWork(const PipelineWorkTriggers &triggers) {
  return triggers.hasNewCameraFrame;
}

bool shouldWriteFramebusFrame(bool framebusExplicitlyRunning,
                              bool hasProgramFrame,
                              bool programWorkRan,
                              bool heartbeatDue) {
  return framebusExplicitlyRunning && hasProgramFrame &&
         (programWorkRan || heartbeatDue);
}

}  // namespace broadify::meeting
