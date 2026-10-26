// parseOptions must keep UTF-8 argument bytes intact: --models-dir and
// --event-log carry user-profile paths (C:\Users\Jürgen\...) that have to
// match the UTF-8 paths the control JSON hands the helper later.
#include "common/options.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

int main() {
  using broadify::meeting::Options;
  using broadify::meeting::parseOptions;
  using broadify::meeting::processArgumentsUtf8;

  // "\xC3\xBC" is the UTF-8 encoding of U+00FC (u-umlaut).
  const std::string modelsDir = "C:\\Users\\J\xC3\xBCrgen\\m";
  const std::string eventLog = "/tmp/\xC3\xBC/events.log";
  const std::string framebus = "bfy-\xC3\xBC-bus";

  const Options options = parseOptions(std::vector<std::string>{
      "meeting-helper", "--models-dir", modelsDir, "--event-log", eventLog,
      "--framebus-name", framebus, "--width", "1280", "--height", "720",
      "--fps", "25", "--preview-port", "9999", "--parent-pid", "4242",
      "--run"});
  CHECK(options.modelsDir == modelsDir);
  CHECK(options.eventLogPath == eventLog);
  CHECK(options.framebusName == framebus);
  CHECK(options.width == 1280u);
  CHECK(options.height == 720u);
  CHECK(options.fps == 25u);
  CHECK(options.previewPort == 9999u);
  CHECK(options.parentPid == 4242);
  CHECK(options.run);

  // Missing value at the end of the argument list yields an empty string,
  // never a read past the end.
  const Options truncated =
      parseOptions(std::vector<std::string>{"meeting-helper", "--models-dir"});
  CHECK(truncated.modelsDir.empty());
  CHECK(!truncated.run);

  // Defaults survive an argument list without flags.
  const Options defaults = parseOptions(std::vector<std::string>{"meeting-helper"});
  CHECK(defaults.width == 1920u);
  CHECK(defaults.height == 1080u);
  CHECK(defaults.fps == 30u);
  CHECK(defaults.previewPort == 9123u);
  CHECK(defaults.parentPid == -1);

  // The argv wrapper decodes to the same vector shape (args[0] = program).
  // On Windows this reads the real command line of the test process, so only
  // the shape is asserted there; elsewhere the bytes must be identical.
  {
    std::string arg0 = "options_test";
    std::string arg1 = "--models-dir";
    std::string arg2 = modelsDir;
    char *argv[] = {arg0.data(), arg1.data(), arg2.data(), nullptr};
    const std::vector<std::string> args = processArgumentsUtf8(3, argv);
    CHECK(!args.empty());
#if !defined(_WIN32)
    CHECK(args.size() == 3u);
    CHECK(args[1] == arg1);
    CHECK(args[2] == modelsDir);
    const Options viaArgv = parseOptions(3, argv);
    CHECK(viaArgv.modelsDir == modelsDir);
#endif
  }

  std::cout << "options_test passed\n";
  return 0;
}
