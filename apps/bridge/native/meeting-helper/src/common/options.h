#pragma once

#include <cstdint>
#include <string>

namespace broadify::meeting {

struct Options {
  bool run = false;
  bool selfTest = false;
  bool keyerSelfTest = false;
  std::string framebusName = "broadify-meeting-framebus";
  std::string controlSocket;
  int parentPid = -1;
  std::string modelsDir;
  uint32_t width = 1920;
  uint32_t height = 1080;
  uint32_t fps = 30;
  uint16_t previewPort = 9123;
  uint16_t vcamFramePort = 18787;
};

Options parseOptions(int argc, char **argv);

}  // namespace broadify::meeting
