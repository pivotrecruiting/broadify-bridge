#include "compose/media_page_cache.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>

using broadify::meeting::MediaPageCache;
using broadify::meeting::MediaPageImage;
using broadify::meeting::deriveSiblingMediaPagePathForTesting;

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

}  // namespace

int main() {
  const std::filesystem::path dir =
      std::filesystem::temp_directory_path() /
      ("broadify-media-page-cache-" + std::to_string(std::rand()));
  std::filesystem::create_directories(dir);

  CHECK(deriveSiblingMediaPagePathForTesting(
            (dir / "deck-page-02.png").string(), 2, 3)
            .find("deck-page-03.png") != std::string::npos);
  CHECK(deriveSiblingMediaPagePathForTesting(
            (dir / "deck-02-page-02.png").string(), 2, 3)
            .empty());

  for (int page = 1; page <= 6; ++page) {
    writeByte(dir / ("deck-page-0" + std::to_string(page) + ".png"),
              static_cast<uint8_t>(page));
  }

  MediaPageCache cache(decodeBytes);
  const std::string page2 = (dir / "deck-page-02.png").string();
  CHECK(!cache.get(page2, 2, 6).image);
  cache.waitForIdleForTesting();
  const auto loaded2 = cache.get(page2, 2, 6);
  CHECK(loaded2.image);
  CHECK(loaded2.image->rgba[0] == 2u);
  CHECK(loaded2.generation != 0u);

  const std::string page3 = (dir / "deck-page-03.png").string();
  cache.waitForIdleForTesting();
  CHECK(cache.get(page3, 3, 6).image);

  const std::string missing = (dir / "deck-page-09.png").string();
  const auto held = cache.get(missing, 9, 9);
  CHECK(held.image);
  CHECK(held.image->rgba[0] == 3u);
  cache.waitForIdleForTesting();
  writeByte(missing, 9u);
  std::this_thread::sleep_for(std::chrono::milliseconds(280));
  CHECK(cache.get(missing, 9, 9).image);
  cache.waitForIdleForTesting();
  const auto loaded9 = cache.get(missing, 9, 9);
  CHECK(loaded9.image);
  CHECK(loaded9.image->rgba[0] == 9u);

  for (int page = 1; page <= 6; ++page) {
    const std::string path =
        (dir / ("deck-page-0" + std::to_string(page) + ".png")).string();
    (void)cache.get(path, page, 6);
    cache.waitForIdleForTesting();
  }
  const auto page2Again = cache.get(page2, 2, 6);
  CHECK(page2Again.image);
  CHECK(page2Again.pending || page2Again.image->rgba[0] == 2u);

  std::filesystem::remove_all(dir);
  std::cout << "media_page_cache_test passed\n";
  return 0;
}
