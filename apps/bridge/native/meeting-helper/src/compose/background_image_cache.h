#pragma once

#include "compose/media_page_cache.h"

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace broadify::meeting {

// Decoded RGBA image; the compositor's RgbaImage is an alias of this type.
using BackgroundImage = MediaPageImage;

using BackgroundImageDecoder =
    std::function<std::shared_ptr<const BackgroundImage>(
        const std::vector<uint8_t> &bytes)>;

// Single-slot cache for the uploaded company background image. The file is
// read through the UTF-8 path helpers (user-profile paths with umlauts open
// on Windows), loaded synchronously on the calling thread (one image, rarely
// changes) and retried with a backoff instead of caching a failure forever.
// Failures emit ONE `background_image_load_failed` helper event per path
// until the load succeeds, success emits `background_image_loaded` once.
// The events' `path` field carries only the file name (basename), never the
// directory: the full path contains the Windows user name, and personal
// data must not reach the helper logs.
class BackgroundImageCache {
 public:
  explicit BackgroundImageCache(BackgroundImageDecoder decoder);

  BackgroundImageCache(const BackgroundImageCache &) = delete;
  BackgroundImageCache &operator=(const BackgroundImageCache &) = delete;

  // Thread-safe. nullptr while the path is empty, the file cannot be read
  // (within the retry backoff) or decoding failed.
  std::shared_ptr<const BackgroundImage> get(const std::string &utf8Path);

 private:
  BackgroundImageDecoder decoder_;
  std::mutex mutex_;
  std::string path_;
  std::shared_ptr<const BackgroundImage> image_;
  uint32_t failures_ = 0;
  bool failedLogged_ = false;
  std::chrono::steady_clock::time_point nextRetryAt_{};
};

}  // namespace broadify::meeting
