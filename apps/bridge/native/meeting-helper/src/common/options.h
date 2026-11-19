#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

struct Options {
  bool run = false;
  // Standalone keyer benchmark (--keyer-self-test): time MODNet inference per
  // input-size mode and exit, instead of running the meeting pipeline.
  bool keyerSelfTest = false;
  bool vcamShmSelfTest = false;
  bool vcamShmReaderSelfTest = false;
  bool vcamShmSelfTestLocalNamespace = false;
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

// The process arguments as UTF-8. On Windows `main(argc, argv)` is ANSI, so
// the wide command line (GetCommandLineW + CommandLineToArgvW) is decoded
// instead; a user name with an umlaut in --models-dir / --event-log then
// matches the UTF-8 paths the control JSON carries. Other platforms copy argv.
std::vector<std::string> processArgumentsUtf8(int argc, char **argv);

// Environment variable as UTF-8 (GetEnvironmentVariableW on Windows,
// std::getenv elsewhere). Empty string when unset or empty.
std::string getenvUtf8(const char *name);

// Parses UTF-8 arguments (args[0] is the program name) on top of the
// MEETING_* environment defaults.
Options parseOptions(const std::vector<std::string> &args);
// Convenience wrapper: processArgumentsUtf8 + parseOptions.
Options parseOptions(int argc, char **argv);

}  // namespace broadify::meeting
