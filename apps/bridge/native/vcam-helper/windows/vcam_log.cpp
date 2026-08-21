#include "vcam_log.h"

#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <string>

namespace broadify::vcam {
namespace {

std::mutex g_logMutex;
constexpr DWORD kMaxLogBytes = 5u * 1024u * 1024u;

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

void rotateLogIfNeeded(const std::string &path) {
  WIN32_FILE_ATTRIBUTE_DATA data{};
  if (!GetFileAttributesExA(path.c_str(), GetFileExInfoStandard, &data)) {
    return;
  }
  const ULONGLONG size =
      (static_cast<ULONGLONG>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
  if (size < kMaxLogBytes) {
    return;
  }
  const std::string rotated = path + ".1";
  DeleteFileA(rotated.c_str());
  MoveFileExA(path.c_str(), rotated.c_str(), MOVEFILE_REPLACE_EXISTING);
}

std::string localTimestamp() {
  SYSTEMTIME time{};
  GetLocalTime(&time);
  char buffer[32];
  snprintf(buffer, sizeof(buffer), "%04u-%02u-%02u %02u:%02u:%02u.%03u",
           time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
           time.wSecond, time.wMilliseconds);
  return buffer;
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
    rotateLogIfNeeded(path);
    FILE *file = nullptr;
    if (fopen_s(&file, path.c_str(), "a") != 0 || file == nullptr) {
      return;
    }
    fprintf(file, "[%s pid=%lu tid=%lu] %s\n", localTimestamp().c_str(),
            static_cast<unsigned long>(GetCurrentProcessId()),
            static_cast<unsigned long>(GetCurrentThreadId()), message);
    fclose(file);
  } catch (...) {
    // Best-effort logging: never propagate a logging failure.
  }
}

}  // namespace broadify::vcam
