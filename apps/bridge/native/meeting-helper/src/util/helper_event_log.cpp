#include "util/helper_event_log.h"

#include <fstream>
#include <iostream>
#include <mutex>

namespace broadify::meeting {
namespace {

std::mutex g_mutex;
std::string g_path;
std::string g_exitReason;

}  // namespace

void setHelperEventLogPath(const std::string &path) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_path = path;
  if (!g_path.empty()) {
    // Truncate: one file per helper run keeps the post-mortem unambiguous.
    std::ofstream file(g_path, std::ios::trunc);
  }
}

void emitHelperEvent(const std::string &jsonLine) {
  std::lock_guard<std::mutex> lock(g_mutex);
  std::cout << jsonLine << std::endl;
  if (g_path.empty()) {
    return;
  }
  // Open per event: incident events are rare, and an always-open handle
  // would be lost by std::_Exit without a flush.
  std::ofstream file(g_path, std::ios::app);
  if (file) {
    file << jsonLine << '\n';
  }
}

void noteHelperExitReason(const std::string &reason) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_exitReason = reason;
}

std::string helperExitReason() {
  std::lock_guard<std::mutex> lock(g_mutex);
  return g_exitReason;
}

}  // namespace broadify::meeting
