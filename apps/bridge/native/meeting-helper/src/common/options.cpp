#include "common/options.h"

#include "util/path_utf8.h"

#include <cstdlib>
#include <limits>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shellapi.h>
#endif

namespace broadify::meeting {
namespace {

uint32_t parseU32(const std::string &value, uint32_t fallback) {
  if (value.empty()) {
    return fallback;
  }
  char *end = nullptr;
  const unsigned long parsed = std::strtoul(value.c_str(), &end, 10);
  if (end == value.c_str() || parsed == 0 || parsed > std::numeric_limits<uint32_t>::max()) {
    return fallback;
  }
  return static_cast<uint32_t>(parsed);
}

uint16_t parseU16(const std::string &value, uint16_t fallback) {
  const uint32_t parsed = parseU32(value, fallback);
  if (parsed > std::numeric_limits<uint16_t>::max()) {
    return fallback;
  }
  return static_cast<uint16_t>(parsed);
}

void setProcessEnv(const std::string &key, const std::string &value) {
#if defined(_WIN32)
  // Wide variant so a non-ASCII value round-trips; the CRT keeps the narrow
  // and wide environment copies in sync for the std::getenv readers.
  const std::wstring wideKey = utf8ToWide(key);
  if (wideKey.empty()) {
    return;
  }
  _wputenv_s(wideKey.c_str(), utf8ToWide(value).c_str());
#else
  setenv(key.c_str(), value.c_str(), 1);
#endif
}

}  // namespace

std::vector<std::string> processArgumentsUtf8(int argc, char **argv) {
  std::vector<std::string> args;
#if defined(_WIN32)
  int wideArgc = 0;
  LPWSTR *wideArgv = CommandLineToArgvW(GetCommandLineW(), &wideArgc);
  if (wideArgv != nullptr) {
    args.reserve(static_cast<size_t>(wideArgc > 0 ? wideArgc : 0));
    for (int i = 0; i < wideArgc; ++i) {
      args.push_back(wideToUtf8(wideArgv[i]));
    }
    LocalFree(wideArgv);
    return args;
  }
  // CommandLineToArgvW failed (out of memory): fall back to the ANSI argv so
  // the helper still starts with its ASCII flags.
#endif
  args.reserve(static_cast<size_t>(argc > 0 ? argc : 0));
  for (int i = 0; i < argc; ++i) {
    args.emplace_back(argv[i] != nullptr ? argv[i] : "");
  }
  return args;
}

std::string getenvUtf8(const char *name) {
  if (name == nullptr || name[0] == '\0') {
    return {};
  }
#if defined(_WIN32)
  const std::wstring wideName = utf8ToWide(name);
  if (wideName.empty()) {
    return {};
  }
  const DWORD needed = GetEnvironmentVariableW(wideName.c_str(), nullptr, 0);
  if (needed == 0) {
    return {};
  }
  std::wstring value(static_cast<size_t>(needed), L'\0');
  const DWORD written =
      GetEnvironmentVariableW(wideName.c_str(), value.data(), needed);
  if (written == 0 || written >= needed) {
    return {};
  }
  value.resize(static_cast<size_t>(written));
  return wideToUtf8(value);
#else
  const char *value = std::getenv(name);
  if (value == nullptr) {
    return {};
  }
  return std::string(value);
#endif
}

Options parseOptions(const std::vector<std::string> &args) {
  Options options;
  if (const std::string value = getenvUtf8("MEETING_FRAMEBUS_NAME"); !value.empty()) {
    options.framebusName = value;
  }
  if (const std::string value = getenvUtf8("MEETING_CONTROL_SOCKET"); !value.empty()) {
    options.controlSocket = value;
  }
  if (const std::string value = getenvUtf8("MEETING_MODELS_DIR"); !value.empty()) {
    options.modelsDir = value;
  }
  if (const std::string value = getenvUtf8("MEETING_EVENT_LOG"); !value.empty()) {
    options.eventLogPath = value;
  }
  options.width = parseU32(getenvUtf8("MEETING_FRAME_WIDTH"), options.width);
  options.height = parseU32(getenvUtf8("MEETING_FRAME_HEIGHT"), options.height);
  options.fps = parseU32(getenvUtf8("MEETING_FRAME_FPS"), options.fps);
  options.previewPort = parseU16(getenvUtf8("MEETING_PREVIEW_PORT"), options.previewPort);
  options.vcamFramePort = parseU16(getenvUtf8("MEETING_VCAM_FRAME_PORT"), options.vcamFramePort);

  for (size_t i = 1; i < args.size(); ++i) {
    const std::string &arg = args[i];
    auto next = [&]() -> std::string {
      if (i + 1 >= args.size()) {
        return "";
      }
      return args[++i];
    };
    if (arg == "--run") {
      options.run = true;
    } else if (arg == "--keyer-self-test") {
      options.keyerSelfTest = true;
    } else if (arg == "--vcam-shm-selftest") {
      options.vcamShmSelfTest = true;
    } else if (arg == "--vcam-shm-reader-selftest") {
      options.vcamShmReaderSelfTest = true;
      options.vcamShmSelfTestControlName = next();
    } else if (arg == "--namespace") {
      options.vcamShmSelfTestLocalNamespace = next() == "local";
    } else if (arg == "--framebus-name") {
      options.framebusName = next();
    } else if (arg == "--control-socket") {
      options.controlSocket = next();
    } else if (arg == "--parent-pid") {
      options.parentPid = static_cast<int>(parseU32(next(), 0u));
    } else if (arg == "--models-dir") {
      options.modelsDir = next();
    } else if (arg == "--event-log") {
      options.eventLogPath = next();
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
      // Re-export a KEY=VALUE pair into the process environment. macOS launches
      // the helper via `open`, which strips the caller's environment, so the
      // bridge forwards dev/keyer overrides (BROADIFY_MEETING_*) this way; the
      // helper's getenv-based overrides then work under `npm run dev`.
      const std::string kv = next();
      const size_t eq = kv.find('=');
      if (eq != std::string::npos && eq > 0u) {
        setProcessEnv(kv.substr(0, eq), kv.substr(eq + 1u));
      }
    }
  }
  return options;
}

Options parseOptions(int argc, char **argv) {
  return parseOptions(processArgumentsUtf8(argc, argv));
}

}  // namespace broadify::meeting
