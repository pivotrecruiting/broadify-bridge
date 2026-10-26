// Round-trips a file through a directory whose name contains a non-ASCII
// character via every UTF-8 open helper. Stdlib + OS primitives only.
#include "helper_common/path_utf8.h"

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

}  // namespace

int main() {
  using broadify::helper::fileExistsUtf8;
  using broadify::helper::fopenUtf8;
  using broadify::helper::openInputFileUtf8;
  using broadify::helper::openOutputFileUtf8;
  using broadify::helper::pathFromUtf8;
  using broadify::helper::readFileBytesUtf8;

  const auto stamp =
      std::chrono::steady_clock::now().time_since_epoch().count();
  // The directory name is built as UTF-8 ("\xC3\xBC" = U+00FC, u-umlaut) and
  // turned into a native path via pathFromUtf8 - the same route a control
  // JSON path takes in production.
  const std::filesystem::path tempDir = std::filesystem::temp_directory_path();
#if defined(_WIN32)
  const std::string tempUtf8 = broadify::helper::wideToUtf8(tempDir.wstring());
#else
  const std::string tempUtf8 = tempDir.string();
#endif
  CHECK(!tempUtf8.empty());
  const std::string dirUtf8 =
      tempUtf8 + "/broadify-\xC3\xBC-" + std::to_string(stamp);
  const std::filesystem::path dir = pathFromUtf8(dirUtf8);
  CHECK(!dir.empty());
  std::filesystem::create_directories(dir);

  // Binary payload with an embedded NUL and a high byte.
  const char rawContent[] = "hello \xC3\xBC world\n\x00\x01\xFF";
  const std::string contentBytes(rawContent, sizeof(rawContent) - 1u);
  const std::string filePathUtf8 = dirUtf8 + "/data-\xC3\xBC.bin";
  {
    // Written through std::filesystem::path (native wide on Windows); the
    // UTF-8 openers must find exactly this file.
    std::ofstream out(pathFromUtf8(filePathUtf8),
                      std::ios::binary | std::ios::trunc);
    CHECK(out.good());
    out.write(contentBytes.data(),
              static_cast<std::streamsize>(contentBytes.size()));
  }

  CHECK(fileExistsUtf8(filePathUtf8));
  CHECK(!fileExistsUtf8(dirUtf8 + "/missing.bin"));
  CHECK(!fileExistsUtf8(""));

  {
    std::ifstream in = openInputFileUtf8(filePathUtf8);
    CHECK(in.good());
    const std::string readBack((std::istreambuf_iterator<char>(in)),
                               std::istreambuf_iterator<char>());
    CHECK(readBack == contentBytes);
  }
  {
    std::ifstream missing = openInputFileUtf8(dirUtf8 + "/missing.bin");
    CHECK(!missing.good());
  }

  {
    FILE *file = fopenUtf8(filePathUtf8, "rb");
    CHECK(file != nullptr);
    std::string readBack(contentBytes.size(), '\0');
    const size_t read = std::fread(readBack.data(), 1u, readBack.size(), file);
    CHECK(read == contentBytes.size());
    CHECK(std::fgetc(file) == EOF);
    std::fclose(file);
    CHECK(readBack == contentBytes);
  }
  {
    errno = 0;
    FILE *missing = fopenUtf8(dirUtf8 + "/missing.bin", "rb");
    CHECK(missing == nullptr);
    CHECK(errno == ENOENT);
  }

  {
    int errorCode = -1;
    const std::vector<uint8_t> bytes = readFileBytesUtf8(filePathUtf8, errorCode);
    CHECK(errorCode == 0);
    CHECK(bytes.size() == contentBytes.size());
    CHECK(std::string(bytes.begin(), bytes.end()) == contentBytes);
  }
  {
    int errorCode = 0;
    const std::vector<uint8_t> bytes =
        readFileBytesUtf8(dirUtf8 + "/missing.bin", errorCode);
    CHECK(bytes.empty());
    CHECK(errorCode == ENOENT);
  }

  {
    const std::string writtenUtf8 = dirUtf8 + "/out-\xC3\xBC.txt";
    std::ofstream out = openOutputFileUtf8(writtenUtf8, std::ios::out | std::ios::trunc);
    CHECK(out.good());
    out << "first\n";
    out.close();
    std::ofstream append = openOutputFileUtf8(writtenUtf8, std::ios::out | std::ios::app);
    CHECK(append.good());
    append << "second\n";
    append.close();
    int errorCode = -1;
    const std::vector<uint8_t> bytes = readFileBytesUtf8(writtenUtf8, errorCode);
    CHECK(errorCode == 0);
    CHECK(std::string(bytes.begin(), bytes.end()) == "first\nsecond\n");
    CHECK(std::filesystem::exists(pathFromUtf8(writtenUtf8)));
    std::ofstream empty = openOutputFileUtf8("", std::ios::out);
    CHECK(!empty.good());
  }

#if defined(_WIN32)
  {
    // "\xFC" is Latin-1 for ü, not valid UTF-8: the strict converter must
    // reject it instead of guessing a code page.
    std::wstring wide;
    CHECK(!broadify::helper::tryUtf8ToWide("\xFC", wide));
    CHECK(wide.empty());
    CHECK(broadify::helper::utf8ToWide("\xFC").empty());
    CHECK(broadify::helper::utf8ToWide("\xC3\xBC") == L"ü");
    CHECK(broadify::helper::wideToUtf8(L"ü") == "\xC3\xBC");
    CHECK(broadify::helper::wideToUtf8(static_cast<const wchar_t *>(nullptr)).empty());
    int errorCode = 0;
    const std::vector<uint8_t> bytes = readFileBytesUtf8(dirUtf8 + "/\xFC.bin", errorCode);
    CHECK(bytes.empty());
    CHECK(errorCode == EINVAL);
    CHECK(pathFromUtf8("\xFC").empty());
    CHECK(!fileExistsUtf8("\xFC"));
  }
#endif

  std::error_code cleanupError;
  std::filesystem::remove_all(dir, cleanupError);
  std::cout << "path_utf8_test passed\n";
  return 0;
}
