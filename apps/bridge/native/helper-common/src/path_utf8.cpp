#include "helper_common/path_utf8.h"

#include <array>
#include <cerrno>
#include <climits>
#include <cstdio>
#include <memory>
#include <utility>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace broadify::helper {

#if defined(_WIN32)

bool tryUtf8ToWide(const std::string &utf8, std::wstring &out) {
  out.clear();
  if (utf8.empty()) {
    return true;
  }
  if (utf8.size() > static_cast<size_t>(INT_MAX)) {
    return false;
  }
  const int length = static_cast<int>(utf8.size());
  const int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                         utf8.data(), length, nullptr, 0);
  if (needed <= 0) {
    return false;
  }
  std::wstring wide(static_cast<size_t>(needed), L'\0');
  const int converted = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                            utf8.data(), length, wide.data(),
                                            needed);
  if (converted != needed) {
    return false;
  }
  out = std::move(wide);
  return true;
}

std::wstring utf8ToWide(const std::string &utf8) {
  std::wstring wide;
  if (!tryUtf8ToWide(utf8, wide)) {
    return std::wstring();
  }
  return wide;
}

std::string wideToUtf8(const wchar_t *wide) {
  if (wide == nullptr || wide[0] == L'\0') {
    return {};
  }
  const int needed =
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  if (needed <= 1) {
    return {};
  }
  std::string out(static_cast<size_t>(needed - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), needed, nullptr,
                      nullptr);
  return out;
}

std::string wideToUtf8(const std::wstring &wide) {
  return wideToUtf8(wide.c_str());
}

#endif  // _WIN32

std::filesystem::path pathFromUtf8(const std::string &utf8) {
#if defined(_WIN32)
  std::wstring wide;
  if (!tryUtf8ToWide(utf8, wide)) {
    return std::filesystem::path();
  }
  return std::filesystem::path(wide);
#else
  // POSIX paths are byte strings; UTF-8 passes through untouched.
  return std::filesystem::path(utf8);
#endif
}

std::ifstream openInputFileUtf8(const std::string &utf8Path,
                                std::ios::openmode mode) {
  std::ifstream stream;
  const std::filesystem::path path = pathFromUtf8(utf8Path);
  if (utf8Path.empty() || path.empty()) {
    stream.setstate(std::ios::failbit);
    return stream;
  }
  stream.open(path, mode);
  return stream;
}

std::ofstream openOutputFileUtf8(const std::string &utf8Path,
                                 std::ios::openmode mode) {
  std::ofstream stream;
  const std::filesystem::path path = pathFromUtf8(utf8Path);
  if (utf8Path.empty() || path.empty()) {
    stream.setstate(std::ios::failbit);
    return stream;
  }
  stream.open(path, mode);
  return stream;
}

FILE *fopenUtf8(const std::string &utf8Path, const char *mode) {
#if defined(_WIN32)
  std::wstring widePath;
  std::wstring wideMode;
  if (!tryUtf8ToWide(utf8Path, widePath) || widePath.empty() ||
      mode == nullptr || !tryUtf8ToWide(mode, wideMode)) {
    errno = EINVAL;
    return nullptr;
  }
  return _wfopen(widePath.c_str(), wideMode.c_str());
#else
  if (mode == nullptr) {
    errno = EINVAL;
    return nullptr;
  }
  return std::fopen(utf8Path.c_str(), mode);
#endif
}

bool fileExistsUtf8(const std::string &utf8Path) {
  const std::ifstream file = openInputFileUtf8(utf8Path, std::ios::binary);
  return file.good();
}

std::vector<uint8_t> readFileBytesUtf8(const std::string &utf8Path,
                                       int &errorCode) {
  errorCode = 0;
  FILE *file = fopenUtf8(utf8Path, "rb");
  if (file == nullptr) {
    errorCode = errno != 0 ? errno : EIO;
    return {};
  }
  std::unique_ptr<FILE, decltype(&std::fclose)> owned(file, &std::fclose);
  std::vector<uint8_t> bytes;
  std::array<uint8_t, 64 * 1024> buffer{};
  while (true) {
    const size_t read = std::fread(buffer.data(), 1u, buffer.size(), file);
    bytes.insert(bytes.end(), buffer.begin(), buffer.begin() + read);
    if (read < buffer.size()) {
      if (std::ferror(file)) {
        errorCode = errno != 0 ? errno : EIO;
        return {};
      }
      break;
    }
  }
  return bytes;
}

}  // namespace broadify::helper
