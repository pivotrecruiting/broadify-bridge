#include "compose/media_page_cache.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "util/helper_event_log.h"

using broadify::meeting::MediaPageCache;
using broadify::meeting::MediaPageImage;
using broadify::meeting::deriveSiblingMediaPagePathForTesting;
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

std::shared_ptr<const MediaPageImage> decodeBytes(
    const std::vector<uint8_t> &bytes) {
  if (bytes.empty() || bytes[0] == 0u) {
    return nullptr;
  }
  auto image = std::make_shared<MediaPageImage>();
  image->width = 1u;
  image->height = 1u;
  image->rgba = {bytes[0], bytes[0], bytes[0], 255u};
  return image;
}

void writeByte(const std::filesystem::path &path, uint8_t value) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
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
  const std::filesystem::path dir =
      std::filesystem::temp_directory_path() /
      ("broadify-media-page-cache-" + std::to_string(std::rand()));
  std::filesystem::create_directories(dir);

  const std::filesystem::path eventLog = dir / "events.jsonl";
  setHelperEventLogPath(eventLog.string());

  CHECK(deriveSiblingMediaPagePathForTesting(
            (dir / "deck-page-0003.png").string(), 3, 4)
            .find("deck-page-0004.png") != std::string::npos);
  CHECK(deriveSiblingMediaPagePathForTesting(
            (dir / "deck-02-page-02.png").string(), 2, 3)
            .empty());

  for (int page = 1; page <= 6; ++page) {
    std::ostringstream name;
    name << "deck-page-000" << page << ".png";
    writeByte(dir / name.str(), static_cast<uint8_t>(page));
  }

  MediaPageCache cache(decodeBytes);
  const std::string page3 = (dir / "deck-page-0003.png").string();
  CHECK(!cache.get(page3, 2, 6).image);
  cache.waitForIdleForTesting();
  const auto loaded3 = cache.get(page3, 2, 6);
  CHECK(loaded3.image);
  CHECK(loaded3.image->rgba[0] == 3u);
  CHECK(loaded3.generation != 0u);

  const std::string page2 = (dir / "deck-page-0002.png").string();
  const std::string page4 = (dir / "deck-page-0004.png").string();
  cache.waitForIdleForTesting();
  CHECK(cache.get(page2, 1, 6).image);
  CHECK(cache.get(page4, 3, 6).image);

  const std::string missing = (dir / "deck-page-0009.png").string();
  const auto held = cache.get(missing, 8, 0);
  CHECK(held.image);
  CHECK(held.image->rgba[0] == 4u);
  cache.waitForIdleForTesting();
  CHECK(countLinesContaining(eventLog, "deck-page-0009.png") == 1);
  (void)cache.get(missing, 8, 0);
  cache.waitForIdleForTesting();
  CHECK(countLinesContaining(eventLog, "deck-page-0009.png") == 1);
  writeByte(missing, 9u);
  std::this_thread::sleep_for(std::chrono::milliseconds(400));
  CHECK(cache.get(missing, 8, 0).image);
  cache.waitForIdleForTesting();
  const auto loaded9 = cache.get(missing, 8, 0);
  CHECK(loaded9.image);
  CHECK(loaded9.image->rgba[0] == 9u);

  for (int page = 1; page <= 6; ++page) {
    std::ostringstream name;
    name << "deck-page-000" << page << ".png";
    const std::string path = (dir / name.str()).string();
    (void)cache.get(path, page - 1, 6);
    cache.waitForIdleForTesting();
  }
  const std::string page1 = (dir / "deck-page-0001.png").string();
  const auto page1Again = cache.get(page1, 0, 6);
  CHECK(page1Again.pending);
  CHECK(page1Again.image);
  CHECK(page1Again.image->rgba[0] == 6u);

  setHelperEventLogPath("");
  std::filesystem::remove_all(dir);
  std::cout << "media_page_cache_test passed\n";
  return 0;
}
