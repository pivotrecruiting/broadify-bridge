#pragma once

// UTF-8 path handling shared by the native helpers.
//
// Every path that reaches a helper (control JSON, argv, environment) is
// UTF-8. On POSIX the narrow C/C++ file APIs take those bytes verbatim; on
// Windows the narrow APIs interpret them in the ANSI code page instead, so a
// user name with an umlaut (C:\Users\Jürgen\...) silently fails to open.
// These helpers route every open through the wide Win32 API (via
// std::filesystem::path / _wfopen) and are byte-transparent elsewhere.
//
// Stdlib + OS primitives only (helper-common rule).

#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <ios>
#include <string>
#include <vector>

namespace broadify::helper {

#if defined(_WIN32)
// Strict UTF-8 -> UTF-16 (MB_ERR_INVALID_CHARS). Returns false and leaves
// `out` empty on invalid input. An empty input converts to an empty output.
bool tryUtf8ToWide(const std::string &utf8, std::wstring &out);
// Strict UTF-8 -> UTF-16; empty string on invalid input.
std::wstring utf8ToWide(const std::string &utf8);
// UTF-16 -> UTF-8. Unpaired surrogates become U+FFFD (the input comes from the
// OS, so it is never rejected). A nullptr pointer yields an empty string.
std::string wideToUtf8(const std::wstring &wide);
std::string wideToUtf8(const wchar_t *wide);
#endif

// std::filesystem::path from a UTF-8 string (u8path semantics on every
// platform). On Windows an invalid UTF-8 input yields an empty path.
std::filesystem::path pathFromUtf8(const std::string &utf8);

// Opens a file for reading. The returned stream has failbit set when the
// path is empty, invalid UTF-8 (Windows) or cannot be opened.
std::ifstream openInputFileUtf8(const std::string &utf8Path,
                                std::ios::openmode mode = std::ios::binary);

// Opens a file for writing with the given mode (std::ios::out is implied by
// std::ofstream). Same failure semantics as openInputFileUtf8.
std::ofstream openOutputFileUtf8(const std::string &utf8Path,
                                 std::ios::openmode mode);

// fopen() with a UTF-8 path: _wfopen on Windows, fopen elsewhere. nullptr on
// failure with errno set (EINVAL for invalid UTF-8 on Windows).
FILE *fopenUtf8(const std::string &utf8Path, const char *mode);

// True when the path can be opened for reading (same test the helpers used
// with a narrow std::ifstream before).
bool fileExistsUtf8(const std::string &utf8Path);

// Reads a whole file. errorCode: 0 on success, errno otherwise (EINVAL for
// invalid UTF-8 on Windows). An unreadable file yields an empty vector.
std::vector<uint8_t> readFileBytesUtf8(const std::string &utf8Path,
                                       int &errorCode);

}  // namespace broadify::helper
