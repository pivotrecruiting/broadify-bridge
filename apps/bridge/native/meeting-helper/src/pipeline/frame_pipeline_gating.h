#pragma once

namespace broadify::meeting {

struct PipelineWorkTriggers {
  bool hasNewCameraFrame = false;
  bool programChanged = false;
  bool graphicsChanged = false;
};

bool shouldRunProgramWork(const PipelineWorkTriggers &triggers);
bool shouldRunFusedKeyerWork(const PipelineWorkTriggers &triggers);
bool shouldWriteFramebusFrame(bool framebusExplicitlyRunning,
                              bool hasProgramFrame,
                              bool programWorkRan,
                              bool heartbeatDue);

}  // namespace broadify::meeting
