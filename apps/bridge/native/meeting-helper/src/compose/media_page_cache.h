#pragma once

#include <condition_variable>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace broadify::meeting {

struct MediaPageImage {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> rgba;
};

using MediaPageDecoder =
    std::function<std::shared_ptr<const MediaPageImage>(
        const std::vector<uint8_t> &bytes)>;

struct MediaPageCacheResult {
  std::shared_ptr<const MediaPageImage> image;
  uint64_t generation = 0;
  std::string path;
  bool pending = false;
};

class MediaPageCache {
 public:
  explicit MediaPageCache(MediaPageDecoder decoder);
  ~MediaPageCache();

  MediaPageCache(const MediaPageCache &) = delete;
  MediaPageCache &operator=(const MediaPageCache &) = delete;

  MediaPageCacheResult get(const std::string &path, int page, int pageCount);
  void waitForIdleForTesting();

 private:
  struct Entry {
    std::shared_ptr<const MediaPageImage> image;
    uint64_t generation = 0;
    uint64_t lastUse = 0;
    uint32_t failures = 0;
    bool loadQueued = false;
    bool loading = false;
    bool failedLogged = false;
    std::chrono::steady_clock::time_point nextRetryAt{};
  };

  void enqueueLocked(const std::string &path, bool prefetch);
  void prefetchSiblingsLocked(const std::string &path, int page, int pageCount);
  void workerMain();
  void finishLoad(const std::string &path,
                  std::shared_ptr<const MediaPageImage> image,
                  const std::string &stage,
                  int errorCode,
                  double decodeMs);
  void pruneLocked();

  MediaPageDecoder decoder_;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::condition_variable idleCv_;
  std::unordered_map<std::string, Entry> entries_;
  std::vector<std::string> queue_;
  std::shared_ptr<const MediaPageImage> displayedImage_;
  std::string displayedPath_;
  std::string lastPrefetchPath_;
  uint64_t displayedGeneration_ = 0;
  uint64_t nextGeneration_ = 1;
  uint64_t useCounter_ = 1;
  bool stopping_ = false;
  std::thread worker_;
};

std::string deriveSiblingMediaPagePathForTesting(const std::string &path,
                                                 int currentPage,
                                                 int targetPage);

}  // namespace broadify::meeting
