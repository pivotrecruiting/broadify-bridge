#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::pgm {

struct PgmOptions {
  bool run = false;
  std::string controlSocket;
  // Bridge PID for the orphan watchdog; -1 = not provided.
  int parentPid = -1;
  // Sidecar file mirroring helper JSON events; empty disables.
  std::string eventLogPath;
  // Synthetic source instead of a device ("1920x1080@60"); empty = devices.
  std::string syntheticSource;
  bool logPerf = false;
  // --probe: enumerate inputs + encoder availability as JSON, then exit.
  bool probe = false;
};

/** `args` are the process arguments in UTF-8, args[0] being the program name. */
PgmOptions parsePgmOptions(const std::vector<std::string> &args);
PgmOptions parsePgmOptions(int argc, char **argv);

/** Parses "WxH@fps" (fps may be fractional like 59.94). Returns false when malformed. */
bool parseSyntheticSpec(const std::string &spec, uint32_t &width, uint32_t &height, double &fps);

}  // namespace broadify::pgm
