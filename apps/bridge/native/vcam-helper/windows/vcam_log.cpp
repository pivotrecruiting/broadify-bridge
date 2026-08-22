#include "vcam_log.h"
#include "build_stamp.h"

#include <windows.h>
#include <accctrl.h>
#include <aclapi.h>
#include <sddl.h>

#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <string>

namespace broadify::vcam {
namespace {

std::mutex g_logMutex;
bool g_buildStampLogged = false;
constexpr DWORD kMaxLogBytes = 5u * 1024u * 1024u;
std::string g_logPath;

std::wstring widen(const std::string &value) {
  if (value.empty()) {
    return {};
  }
  const int length =
      MultiByteToWideChar(CP_ACP, 0, value.c_str(), -1, nullptr, 0);
  if (length <= 0) {
    return {};
  }
  std::wstring wide(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(CP_ACP, 0, value.c_str(), -1, wide.data(), length);
  wide.resize(static_cast<size_t>(length - 1));
  return wide;
}

bool applyDacl(const std::wstring &path, bool directory) {
  const wchar_t *sddl =
      directory
          ? L"D:PAI(A;OICI;0x1301bf;;;AU)(A;OICI;0x1301bf;;;LS)(A;OICI;FA;;;OW)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)"
          : L"D:PAI(A;;0x1301bf;;;AU)(A;;0x1301bf;;;LS)(A;;FA;;;OW)(A;;FA;;;BA)(A;;FA;;;SY)";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl, SDDL_REVISION_1, &descriptor, nullptr)) {
    return false;
  }
  PACL dacl = nullptr;
  BOOL daclPresent = FALSE;
  BOOL daclDefaulted = FALSE;
  const BOOL daclOk =
      GetSecurityDescriptorDacl(descriptor, &daclPresent, &dacl, &daclDefaulted);
  DWORD result = ERROR_INVALID_SECURITY_DESCR;
  if (daclOk && daclPresent) {
    std::wstring mutablePath = path;
    result = SetNamedSecurityInfoW(
        mutablePath.data(), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl, nullptr);
  }
  LocalFree(descriptor);
  return result == ERROR_SUCCESS;
}

bool appendProbe(const std::string &path) {
  FILE *file = nullptr;
  if (fopen_s(&file, path.c_str(), "a") != 0 || file == nullptr) {
    return false;
  }
  fclose(file);
  return true;
}

std::string processIdentity() {
  DWORD sessionId = 0;
  ProcessIdToSessionId(GetCurrentProcessId(), &sessionId);
  std::string user = "unknown";
  HANDLE token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    DWORD bytes = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
    std::string buffer(bytes, '\0');
    auto *tokenUser = reinterpret_cast<TOKEN_USER *>(buffer.data());
    if (GetTokenInformation(token, TokenUser, tokenUser, bytes, &bytes)) {
      BYTE localServiceSidBuffer[SECURITY_MAX_SID_SIZE];
      DWORD localServiceSidSize = sizeof(localServiceSidBuffer);
      PSID localServiceSid = localServiceSidBuffer;
      if (CreateWellKnownSid(WinLocalServiceSid, nullptr, localServiceSid,
                             &localServiceSidSize) &&
          EqualSid(tokenUser->User.Sid, localServiceSid)) {
        user = "LOCAL_SERVICE";
      } else {
        LPSTR sidString = nullptr;
        if (ConvertSidToStringSidA(tokenUser->User.Sid, &sidString)) {
          user = sidString;
          LocalFree(sidString);
        } else {
          user = "interactive";
        }
      }
    }
    CloseHandle(token);
  }
  char buffer[128];
  snprintf(buffer, sizeof(buffer), "session=%lu user=%s",
           static_cast<unsigned long>(sessionId), user.c_str());
  return buffer;
}

// Resolve %ProgramData%\Broadify, set an explicit DACL for the Frame Server's
// LOCAL SERVICE token, and return either the shared log or a per-pid fallback.
std::string resolveLogPath() {
  if (!g_logPath.empty()) {
    return g_logPath;
  }
  char programData[MAX_PATH] = {0};
  const DWORD length =
      GetEnvironmentVariableA("ProgramData", programData, MAX_PATH);
  if (length == 0 || length >= MAX_PATH) {
    return {};
  }
  std::string dir = std::string(programData) + "\\Broadify";
  const std::wstring dirWide = widen(dir);
  if (dirWide.empty()) {
    return {};
  }
  if (!CreateDirectoryA(dir.c_str(), nullptr) &&
      GetLastError() != ERROR_ALREADY_EXISTS) {
    return {};
  }
  applyDacl(dirWide, true);

  const std::string shared = dir + "\\vcam.log";
  HANDLE file = CreateFileA(
      shared.c_str(), FILE_APPEND_DATA | READ_CONTROL | WRITE_DAC,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file != INVALID_HANDLE_VALUE) {
    CloseHandle(file);
    applyDacl(widen(shared), false);
  }
  if (appendProbe(shared)) {
    g_logPath = shared;
    return g_logPath;
  }

  char fallback[MAX_PATH];
  snprintf(fallback, sizeof(fallback), "%s\\vcam-%lu.log", dir.c_str(),
           static_cast<unsigned long>(GetCurrentProcessId()));
  const std::string perPid = fallback;
  HANDLE fallbackFile = CreateFileA(
      perPid.c_str(), FILE_APPEND_DATA | READ_CONTROL | WRITE_DAC,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (fallbackFile != INVALID_HANDLE_VALUE) {
    CloseHandle(fallbackFile);
    applyDacl(widen(perPid), false);
  }
  if (appendProbe(perPid)) {
    g_logPath = perPid;
  }
  return g_logPath;
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
    if (!g_buildStampLogged) {
      fprintf(file, "[%s pid=%lu tid=%lu] build_stamp git_sha=%s build_time=%s %s\n",
              localTimestamp().c_str(),
              static_cast<unsigned long>(GetCurrentProcessId()),
              static_cast<unsigned long>(GetCurrentThreadId()),
              BROADIFY_BUILD_GIT_SHA, BROADIFY_BUILD_TIMESTAMP,
              processIdentity().c_str());
      g_buildStampLogged = true;
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
