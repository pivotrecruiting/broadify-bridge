// The uploaded background image must load from a path with non-ASCII
// characters, must not cache a failed open forever, and must report the
// failure exactly once per path.
#include "compose/background_image_cache.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#include "util/helper_event_log.h"
#include "util/path_utf8.h"

using broadify::meeting::BackgroundImage;
using broadify::meeting::BackgroundImageCache;
using broadify::meeting::pathFromUtf8;
using broadify::meeting::setHelperEventLogPath;

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

namespace {

std::shared_ptr<const BackgroundImage> decodeBytes(
    const std::vector<uint8_t> &bytes) {
  if (bytes.empty() || bytes[0] == 0u) {
    return nullptr;
  }
  auto image = std::make_shared<BackgroundImage>();
  image->width = 1u;
  image->height = 1u;
  image->rgba = {bytes[0], bytes[0], bytes[0], 255u};
  return image;
}

void writeByte(const std::string &utf8Path, uint8_t value) {
  std::ofstream file(pathFromUtf8(utf8Path), std::ios::binary | std::ios::trunc);
  CHECK(file.good());
  file.put(static_cast<char>(value));
}

int countLinesContaining(const std::filesystem::path &path,
                         const std::string &needle) {
  std::ifstream file(path);
  int count = 0;
  std::string line;
  while (std::getline(file, line)) {
    if (line.find(needle) != std::string::npos) {
      ++count;
    }
  }
  return count;
}

}  // namespace

int main() {
  const auto stamp =
      std::chrono::steady_clock::now().time_since_epoch().count();
  const std::filesystem::path tempDir = std::filesystem::temp_directory_path();
#if defined(_WIN32)
  const std::string tempUtf8 = broadify::meeting::wideToUtf8(tempDir.wstring());
#else
  const std::string tempUtf8 = tempDir.string();
#endif
  // "\xC3\xBC" is UTF-8 for U+00FC (u-umlaut): the directory stands in for
  // C:\Users\Jürgen\AppData\... in the field.
  const std::string dirUtf8 =
      tempUtf8 + "/broadify-bg-\xC3\xBC-" + std::to_string(stamp);
  const std::filesystem::path dir = pathFromUtf8(dirUtf8);
  std::filesystem::create_directories(dir);

  const std::filesystem::path eventLog = dir / "events.jsonl";
  setHelperEventLogPath(eventLog.string());

  BackgroundImageCache cache(decodeBytes);

  // Empty path: nothing to load, no events.
  CHECK(!cache.get(""));

  // (1) A file in a path containing a non-ASCII character decodes.
  const std::string background = dirUtf8 + "/hintergrund-\xC3\xBC.png";
  writeByte(background, 7u);
  const auto loaded = cache.get(background);
  CHECK(loaded);
  CHECK(loaded->rgba[0] == 7u);
  CHECK(cache.get(background) == loaded);
  CHECK(countLinesContaining(eventLog, "background_image_loaded") == 1);
  // Only the file name is logged: the directory (which stands in for the
  // user-profile path) must never appear in the event log.
  CHECK(countLinesContaining(eventLog, "\"path\":\"hintergrund-\xC3\xBC.png\"") == 1);
  CHECK(countLinesContaining(eventLog, "broadify-bg-") == 0);

  // (2) Missing file: nullptr and exactly ONE failure event across 10 calls.
  const std::string missing = dirUtf8 + "/missing-\xC3\xBC.png";
  for (int i = 0; i < 10; ++i) {
    CHECK(!cache.get(missing));
  }
  CHECK(countLinesContaining(eventLog, "background_image_load_failed") == 1);
  CHECK(countLinesContaining(eventLog, "\"path\":\"missing-\xC3\xBC.png\"") == 1);
  CHECK(countLinesContaining(eventLog, "broadify-bg-") == 0);
  CHECK(countLinesContaining(eventLog, "\"stage\":\"open\",\"errno\":2}") == 1);

  // (3) The file appears later: after the backoff the image is served (the
  // failure is not cached permanently).
  writeByte(missing, 9u);
  std::this_thread::sleep_for(std::chrono::milliseconds(450));
  std::shared_ptr<const BackgroundImage> recovered = cache.get(missing);
  for (int attempt = 0; !recovered && attempt < 40; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    recovered = cache.get(missing);
  }
  CHECK(recovered);
  CHECK(recovered->rgba[0] == 9u);
  CHECK(countLinesContaining(eventLog, "background_image_loaded") == 2);
  CHECK(countLinesContaining(eventLog, "background_image_load_failed") == 1);

  // Decode failure is reported with stage "decode".
  const std::string undecodable = dirUtf8 + "/undecodable.png";
  writeByte(undecodable, 0u);
  CHECK(!cache.get(undecodable));
  CHECK(!cache.get(undecodable));
  CHECK(countLinesContaining(eventLog, "\"stage\":\"decode\",\"errno\":0}") == 1);
  CHECK(countLinesContaining(eventLog, "background_image_load_failed") == 2);

  // (4) A path change invalidates the slot in both directions.
  const auto first = cache.get(background);
  CHECK(first);
  CHECK(first->rgba[0] == 7u);
  const auto second = cache.get(missing);
  CHECK(second);
  CHECK(second->rgba[0] == 9u);
  CHECK(first != second);
  CHECK(!cache.get(""));
  CHECK(cache.get(background)->rgba[0] == 7u);

  // Switching back to a path whose failure was already reported reports it
  // again - the once-per-path rule is per slot occupancy, so a later
  // regression is still visible in the log.
  std::filesystem::remove(pathFromUtf8(undecodable));
  CHECK(!cache.get(undecodable));
  CHECK(countLinesContaining(eventLog, "background_image_load_failed") == 3);

  // Final sweep: no event line ever carried the directory part.
  CHECK(countLinesContaining(eventLog, "broadify-bg-") == 0);
  CHECK(countLinesContaining(eventLog, tempUtf8) == 0);

  setHelperEventLogPath("");
  std::error_code cleanupError;
  std::filesystem::remove_all(dir, cleanupError);
  std::cout << "background_image_cache_test passed\n";
  return 0;
}
