#include "common/pgm_options.h"

#include <cstdlib>
#include <cstring>

namespace broadify::pgm {

PgmOptions parsePgmOptions(int argc, char **argv) {
  PgmOptions options;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto next = [&](std::string &out) {
      if (i + 1 < argc) {
        out = argv[++i];
      }
    };
    if (arg == "--run") {
      options.run = true;
    } else if (arg == "--probe") {
      options.probe = true;
    } else if (arg == "--log-perf") {
      options.logPerf = true;
    } else if (arg == "--control-socket") {
      next(options.controlSocket);
    } else if (arg == "--event-log") {
      next(options.eventLogPath);
    } else if (arg == "--synthetic-source") {
      next(options.syntheticSource);
    } else if (arg == "--parent-pid") {
      std::string value;
      next(value);
      options.parentPid = value.empty() ? -1 : std::atoi(value.c_str());
    }
  }
  if (options.controlSocket.empty()) {
    if (const char *env = std::getenv("PGM_CONTROL_SOCKET")) {
      options.controlSocket = env;
    }
  }
  return options;
}

bool parseSyntheticSpec(const std::string &spec, uint32_t &width, uint32_t &height, double &fps) {
  const size_t x = spec.find('x');
  const size_t at = spec.find('@');
  if (x == std::string::npos || at == std::string::npos || at < x) {
    return false;
  }
  const long w = std::strtol(spec.substr(0, x).c_str(), nullptr, 10);
  const long h = std::strtol(spec.substr(x + 1, at - x - 1).c_str(), nullptr, 10);
  const double f = std::strtod(spec.substr(at + 1).c_str(), nullptr);
  if (w < 16 || h < 16 || w > 8192 || h > 8192 || f <= 0.0 || f > 240.0) {
    return false;
  }
  width = static_cast<uint32_t>(w);
  height = static_cast<uint32_t>(h);
  fps = f;
  return true;
}

}  // namespace broadify::pgm
