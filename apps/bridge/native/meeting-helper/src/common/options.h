#pragma once

#include <cstdint>
#include <string>

namespace broadify::meeting {

struct Options {
  bool run = false;
  // Standalone keyer benchmark (--keyer-self-test): time MODNet inference per
  // input-size mode and exit, instead of running the meeting pipeline.
  bool keyerSelfTest = false;
  bool vcamShmSelfTest = false;
  bool vcamShmReaderSelfTest = false;
  std::string vcamShmSelfTestControlName;
  std::string framebusName = "broadify-meeting-framebus";
  std::string controlSocket;
  // Bridge PID for the orphan watchdog; -1 = not provided.
  int parentPid = -1;
  std::string modelsDir;
  // Sidecar file mirroring helper JSON events; empty disables. On macOS the
  // `open`-based launch swallows stdio, so this is the surviving channel.
  std::string eventLogPath;
  uint32_t width = 1920;
  uint32_t height = 1080;
  uint32_t fps = 30;
  uint16_t previewPort = 9123;
  uint16_t vcamFramePort = 18787;
};

Options parseOptions(int argc, char **argv);

}  // namespace broadify::meeting
