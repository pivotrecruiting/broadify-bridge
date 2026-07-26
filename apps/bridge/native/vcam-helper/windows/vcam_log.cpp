#include "vcam_log.h"

#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <string>

namespace broadify::vcam {
namespace {

std::mutex g_logMutex;

// Resolve %ProgramData%\Broadify and make sure it exists. Returns an empty
// string on any failure (logging then becomes a no-op).
std::string resolveLogPath() {
  char programData[MAX_PATH] = {0};
  const DWORD length =
      GetEnvironmentVariableA("ProgramData", programData, MAX_PATH);
  if (length == 0 || length >= MAX_PATH) {
    return {};
  }
  std::string dir = std::string(programData) + "\\Broadify";
  // ERROR_ALREADY_EXISTS is fine; anything else means we cannot write there.
  if (!CreateDirectoryA(dir.c_str(), nullptr) &&
      GetLastError() != ERROR_ALREADY_EXISTS) {
    return {};
  }
  return dir + "\\vcam.log";
}

}  // namespace

void VcamLog(const char *format, ...) {
  // Nothing in here may throw or crash: wrap the whole body defensively.
  try {
    char message[1024];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);

    std::lock_guard<std::mutex> lock(g_logMutex);
    const std::string path = resolveLogPath();
    if (path.empty()) {
      return;
    }
    FILE *file = nullptr;
    if (fopen_s(&file, path.c_str(), "a") != 0 || file == nullptr) {
      return;
    }
    fprintf(file, "[%llu] %s\n",
            static_cast<unsigned long long>(GetTickCount64()), message);
    fclose(file);
  } catch (...) {
    // Best-effort logging: never propagate a logging failure.
  }
}

}  // namespace broadify::vcam
