#include "common/options.h"

#include <cstdlib>
#include <limits>

namespace broadify::meeting {
namespace {

const char *getenvOrNull(const char *name) {
  const char *value = std::getenv(name);
  if (value == nullptr || value[0] == '\0') {
    return nullptr;
  }
  return value;
}

uint32_t parseU32(const char *value, uint32_t fallback) {
  if (value == nullptr) {
    return fallback;
  }
  char *end = nullptr;
  const unsigned long parsed = std::strtoul(value, &end, 10);
  if (end == value || parsed == 0 || parsed > std::numeric_limits<uint32_t>::max()) {
    return fallback;
  }
  return static_cast<uint32_t>(parsed);
}

uint16_t parseU16(const char *value, uint16_t fallback) {
  const uint32_t parsed = parseU32(value, fallback);
  if (parsed > std::numeric_limits<uint16_t>::max()) {
    return fallback;
  }
  return static_cast<uint16_t>(parsed);
}

}  // namespace

Options parseOptions(int argc, char **argv) {
  Options options;
  if (const char *value = getenvOrNull("MEETING_FRAMEBUS_NAME")) {
    options.framebusName = value;
  }
  if (const char *value = getenvOrNull("MEETING_CONTROL_SOCKET")) {
    options.controlSocket = value;
  }
  if (const char *value = getenvOrNull("MEETING_MODELS_DIR")) {
    options.modelsDir = value;
  }
  options.width = parseU32(getenvOrNull("MEETING_FRAME_WIDTH"), options.width);
  options.height = parseU32(getenvOrNull("MEETING_FRAME_HEIGHT"), options.height);
  options.fps = parseU32(getenvOrNull("MEETING_FRAME_FPS"), options.fps);
  options.previewPort = parseU16(getenvOrNull("MEETING_PREVIEW_PORT"), options.previewPort);

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto next = [&]() -> const char * {
      if (i + 1 >= argc) {
        return "";
      }
      return argv[++i];
    };
    if (arg == "--run") {
      options.run = true;
    } else if (arg == "--framebus-name") {
      options.framebusName = next();
    } else if (arg == "--control-socket") {
      options.controlSocket = next();
    } else if (arg == "--models-dir") {
      options.modelsDir = next();
    } else if (arg == "--width") {
      options.width = parseU32(next(), options.width);
    } else if (arg == "--height") {
      options.height = parseU32(next(), options.height);
    } else if (arg == "--fps") {
      options.fps = parseU32(next(), options.fps);
    } else if (arg == "--preview-port") {
      options.previewPort = parseU16(next(), options.previewPort);
    }
  }
  return options;
}

}  // namespace broadify::meeting
