#include "compose/media_page_cache.h"

#include "util/helper_event_log.h"
#include "util/json_utils.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace broadify::meeting {
namespace {

constexpr size_t kMaxDecodedPages = 4u;
constexpr auto kInitialRetryDelay = std::chrono::milliseconds(250);
constexpr auto kMaxRetryDelay = std::chrono::milliseconds(2000);

std::vector<uint8_t> readFileBytes(const std::string &path, int &errorCode) {
  errorCode = 0;
#if defined(_WIN32)
  const int wideSize = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1,
                                           nullptr, 0);
  if (wideSize <= 1) {
    errorCode = ERROR_INVALID_NAME;
    return {};
  }
  std::wstring widePath(static_cast<size_t>(wideSize - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, widePath.data(), wideSize);
  FILE *file = _wfopen(widePath.c_str(), L"rb");
  if (file == nullptr) {
    errorCode = errno;
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
        errorCode = errno;
        return {};
      }
      break;
    }
  }
  return bytes;
#else
  std::ifstream file(std::filesystem::path(path), std::ios::binary);
  if (!file) {
    errorCode = errno;
    return {};
  }
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(file)),
                              std::istreambuf_iterator<char>());
#endif
}

bool isDigit(char ch) { return ch >= '0' && ch <= '9'; }

std::string zeroPadNumber(int value, size_t width) {
  std::ostringstream out;
  out.width(static_cast<std::streamsize>(width));
  out.fill('0');
  out << value;
  return out.str();
}

}  // namespace

std::string deriveSiblingMediaPagePathForTesting(const std::string &path,
                                                 int currentPage,
                                                 int targetPage) {
  if (path.empty() || currentPage <= 0 || targetPage <= 0) {
    return {};
  }
  const std::string current = std::to_string(currentPage);
  const std::string currentPadded = zeroPadNumber(currentPage, 2u);
  const size_t fileStart = path.find_last_of("/\\") == std::string::npos
                               ? 0u
                               : path.find_last_of("/\\") + 1u;
  std::vector<std::pair<size_t, size_t>> matches;
  for (size_t pos = fileStart; pos < path.size();) {
    if (!isDigit(path[pos])) {
      ++pos;
      continue;
    }
    const size_t start = pos;
    while (pos < path.size() && isDigit(path[pos])) {
      ++pos;
    }
    const std::string token = path.substr(start, pos - start);
    if (token == current || token == currentPadded) {
      matches.push_back({start, token.size()});
    }
  }
  if (matches.size() != 1u) {
    return {};
  }
  std::string sibling = path;
  sibling.replace(matches[0].first, matches[0].second,
                  zeroPadNumber(targetPage, matches[0].second));
  return sibling;
}

MediaPageCache::MediaPageCache(MediaPageDecoder decoder)
    : decoder_(std::move(decoder)),
      worker_(&MediaPageCache::workerMain, this) {}

MediaPageCache::~MediaPageCache() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  cv_.notify_all();
  if (worker_.joinable()) {
    worker_.join();
  }
}

MediaPageCacheResult MediaPageCache::get(const std::string &path,
                                         int page,
                                         int pageCount) {
  if (path.empty()) {
    return {};
  }
  std::lock_guard<std::mutex> lock(mutex_);
  Entry &entry = entries_[path];
  entry.lastUse = useCounter_++;
  if (entry.image) {
    displayedImage_ = entry.image;
    displayedPath_ = path;
    displayedGeneration_ = entry.generation;
    prefetchSiblingsLocked(path, page, pageCount);
    return MediaPageCacheResult{entry.image, entry.generation, path, false};
  }
  enqueueLocked(path, false);
  prefetchSiblingsLocked(path, page, pageCount);
  return MediaPageCacheResult{displayedImage_, displayedGeneration_,
                              displayedPath_, true};
}

void MediaPageCache::waitForIdleForTesting() {
  std::unique_lock<std::mutex> lock(mutex_);
  idleCv_.wait(lock, [this] {
    if (!queue_.empty()) {
      return false;
    }
    for (const auto &item : entries_) {
      if (item.second.loading || item.second.loadQueued) {
        return false;
      }
    }
    return true;
  });
}

void MediaPageCache::enqueueLocked(const std::string &path, bool prefetch) {
  Entry &entry = entries_[path];
  const auto now = std::chrono::steady_clock::now();
  if (entry.image || entry.loading || entry.loadQueued ||
      (!prefetch && now < entry.nextRetryAt) ||
      (prefetch && entry.failures > 0u && now < entry.nextRetryAt)) {
    return;
  }
  entry.loadQueued = true;
  queue_.push_back(path);
  cv_.notify_all();
}

void MediaPageCache::prefetchSiblingsLocked(const std::string &path,
                                           int page,
                                           int pageCount) {
  if (page <= 0 || pageCount <= 0) {
    return;
  }
  for (int sibling : {page - 1, page + 1}) {
    if (sibling < 1 || sibling > pageCount) {
      continue;
    }
    const std::string siblingPath =
        deriveSiblingMediaPagePathForTesting(path, page, sibling);
    if (!siblingPath.empty()) {
      enqueueLocked(siblingPath, true);
    }
  }
}

void MediaPageCache::workerMain() {
  while (true) {
    std::string path;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_ && queue_.empty()) {
        return;
      }
      path = queue_.front();
      queue_.erase(queue_.begin());
      Entry &entry = entries_[path];
      entry.loadQueued = false;
      entry.loading = true;
    }

    int errorCode = 0;
    const auto started = std::chrono::steady_clock::now();
    std::vector<uint8_t> bytes = readFileBytes(path, errorCode);
    std::shared_ptr<const MediaPageImage> image;
    std::string stage = "open";
    if (errorCode == 0 && !bytes.empty()) {
      stage = "decode";
      image = decoder_(bytes);
    }
    const auto finished = std::chrono::steady_clock::now();
    const double decodeMs =
        std::chrono::duration<double, std::milli>(finished - started).count();
    finishLoad(path, image, image ? "" : stage, errorCode, decodeMs);
  }
}

void MediaPageCache::finishLoad(const std::string &path,
                                std::shared_ptr<const MediaPageImage> image,
                                const std::string &stage,
                                int errorCode,
                                double decodeMs) {
  std::lock_guard<std::mutex> lock(mutex_);
  Entry &entry = entries_[path];
  entry.loading = false;
  entry.lastUse = useCounter_++;
  if (image) {
    entry.image = image;
    entry.generation = nextGeneration_++;
    entry.failures = 0u;
    entry.failedLogged = false;
    entry.nextRetryAt = {};
    pruneLocked();
    std::ostringstream event;
    event << "{\"type\":\"media_page_loaded\",\"path\":\"" << jsonEscape(path)
          << "\",\"decode_ms\":" << decodeMs << "}";
    emitHelperEvent(event.str());
  } else {
    entry.image.reset();
    entry.failures = std::min<uint32_t>(entry.failures + 1u, 4u);
    const auto delay = std::min(kInitialRetryDelay * (1 << (entry.failures - 1u)),
                                kMaxRetryDelay);
    entry.nextRetryAt = std::chrono::steady_clock::now() + delay;
    if (!entry.failedLogged) {
      std::ostringstream event;
      event << "{\"type\":\"media_page_load_failed\",\"path\":\""
            << jsonEscape(path) << "\",\"stage\":\"" << jsonEscape(stage)
            << "\",\"errno\":" << errorCode << "}";
      emitHelperEvent(event.str());
      entry.failedLogged = true;
    }
  }
  idleCv_.notify_all();
}

void MediaPageCache::pruneLocked() {
  size_t decodedCount = 0;
  for (const auto &item : entries_) {
    if (item.second.image) {
      ++decodedCount;
    }
  }
  while (decodedCount > kMaxDecodedPages) {
    auto victim = entries_.end();
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      if (!it->second.image || it->first == displayedPath_) {
        continue;
      }
      if (victim == entries_.end() ||
          it->second.lastUse < victim->second.lastUse) {
        victim = it;
      }
    }
    if (victim == entries_.end()) {
      break;
    }
    victim->second.image.reset();
    --decodedCount;
  }
}

}  // namespace broadify::meeting
