#include "compose/background_image_cache.h"

#include "util/helper_event_log.h"
#include "util/json_utils.h"
#include "util/path_utf8.h"

#include <algorithm>
#include <sstream>
#include <utility>

namespace broadify::meeting {
namespace {

// Same backoff as MediaPageCache: 400 ms * 2^n, capped at 2 s.
constexpr auto kInitialRetryDelay = std::chrono::milliseconds(400);
constexpr auto kMaxRetryDelay = std::chrono::milliseconds(2000);
constexpr uint32_t kMaxFailureExponent = 4u;

// File name without its directory, for the helper events. The directory
// part of a background image path is the bridge's userData directory and
// therefore contains the user name - it stays out of the logs.
std::string pathBasename(const std::string &path) {
  const size_t slash = path.find_last_of("/\\");
  if (slash == std::string::npos) {
    return path;
  }
  return path.substr(slash + 1u);
}

}  // namespace

BackgroundImageCache::BackgroundImageCache(BackgroundImageDecoder decoder)
    : decoder_(std::move(decoder)) {}

std::shared_ptr<const BackgroundImage> BackgroundImageCache::get(
    const std::string &utf8Path) {
  std::string eventJson;
  std::shared_ptr<const BackgroundImage> result;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (utf8Path != path_) {
      // Path change (including clearing) drops the slot and the retry state.
      path_ = utf8Path;
      image_.reset();
      failures_ = 0u;
      failedLogged_ = false;
      nextRetryAt_ = {};
    }
    if (path_.empty()) {
      return nullptr;
    }
    if (image_) {
      return image_;
    }
    const auto now = std::chrono::steady_clock::now();
    if (now < nextRetryAt_) {
      return nullptr;
    }

    int errorCode = 0;
    const std::vector<uint8_t> bytes = readFileBytesUtf8(path_, errorCode);
    std::string stage = "open";
    std::shared_ptr<const BackgroundImage> image;
    if (errorCode == 0 && !bytes.empty()) {
      stage = "decode";
      image = decoder_(bytes);
    }
    if (image) {
      image_ = image;
      failures_ = 0u;
      failedLogged_ = false;
      nextRetryAt_ = {};
      std::ostringstream event;
      event << "{\"type\":\"background_image_loaded\",\"path\":\""
            << jsonEscape(pathBasename(path_)) << "\"}";
      eventJson = event.str();
    } else {
      failures_ = std::min(failures_ + 1u, kMaxFailureExponent);
      const auto delay = std::min(
          kInitialRetryDelay * (1 << (failures_ - 1u)), kMaxRetryDelay);
      nextRetryAt_ = now + delay;
      if (!failedLogged_) {
        std::ostringstream event;
        event << "{\"type\":\"background_image_load_failed\",\"path\":\""
              << jsonEscape(pathBasename(path_)) << "\",\"stage\":\""
              << jsonEscape(stage)
              << "\",\"errno\":" << errorCode << "}";
        eventJson = event.str();
        failedLogged_ = true;
      }
    }
    result = image_;
  }
  if (!eventJson.empty()) {
    emitHelperEvent(eventJson);
  }
  return result;
}

}  // namespace broadify::meeting
