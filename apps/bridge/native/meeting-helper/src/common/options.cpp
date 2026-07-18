#include "common/options.h"

#include <algorithm>
#include <array>
#include <cctype>
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

bool isForwardedEnvironmentKey(const std::string &key) {
  static constexpr std::array<const char *, 14> kAllowedKeys = {
      "BROADIFY_MEETING_COREML_UNITS",
      "BROADIFY_MEETING_GPU_COMPOSITOR",
      "BROADIFY_MEETING_GPU_COMPOSITOR_D3D11",
      "BROADIFY_MEETING_GPU_EMA",
      "BROADIFY_MEETING_GPU_EPSILON",
      "BROADIFY_MEETING_GPU_GUIDED",
      "BROADIFY_MEETING_GPU_PIPELINE",
      "BROADIFY_MEETING_GPU_RADIUS",
      "BROADIFY_MEETING_GPU_REFINE",
      "BROADIFY_MEETING_GPU_REFINE_WIDTH",
      "BROADIFY_MEETING_GUIDED_EPSILON",
      "BROADIFY_MEETING_GUIDED_RADIUS",
      "BROADIFY_MEETING_GUIDED_REFINE",
      "BROADIFY_MEETING_KEYER_DML_LEGACY",
  };
  return std::find(kAllowedKeys.begin(), kAllowedKeys.end(), key) !=
      kAllowedKeys.end();
}

bool isForwardedEnvironmentValue(const std::string &value) {
  if (value.empty() || value.size() > 64u) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](const char character) {
    const unsigned char byte = static_cast<unsigned char>(character);
    return std::isalnum(byte) != 0 || character == '.' || character == '_' ||
        character == '+' || character == '-';
  });
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
  options.vcamFramePort = parseU16(getenvOrNull("MEETING_VCAM_FRAME_PORT"), options.vcamFramePort);

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
    } else if (arg == "--self-test") {
      options.selfTest = true;
    } else if (arg == "--keyer-self-test") {
      options.keyerSelfTest = true;
    } else if (arg == "--framebus-name") {
      options.framebusName = next();
    } else if (arg == "--control-socket") {
      options.controlSocket = next();
    } else if (arg == "--parent-pid") {
      options.parentPid = static_cast<int>(parseU32(next(), 0u));
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
    } else if (arg == "--vcam-frame-port") {
      options.vcamFramePort = parseU16(next(), options.vcamFramePort);
    } else if (arg == "--env") {
      const std::string keyValue = next();
      const size_t separator = keyValue.find('=');
      if (separator != std::string::npos && separator > 0u) {
        const std::string key = keyValue.substr(0, separator);
        const std::string value = keyValue.substr(separator + 1u);
        if (isForwardedEnvironmentKey(key) &&
            isForwardedEnvironmentValue(value)) {
#if defined(_WIN32)
          _putenv_s(key.c_str(), value.c_str());
#else
          setenv(key.c_str(), value.c_str(), 1);
#endif
        }
      }
    }
  }
  return options;
}

}  // namespace broadify::meeting
