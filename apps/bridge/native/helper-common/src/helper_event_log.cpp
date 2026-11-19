#include "helper_common/helper_event_log.h"
#include "helper_common/path_utf8.h"

#include <fstream>
#include <iostream>
#include <mutex>

namespace broadify::helper {
namespace {

std::mutex g_mutex;
std::string g_path;
std::string g_exitReason;
std::ofstream g_file;

}  // namespace

void setHelperEventLogPath(const std::string &path) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_file.is_open()) {
    g_file.close();
  }
  g_path = path;
  if (!g_path.empty()) {
    // Truncate: one file per helper run keeps the post-mortem unambiguous.
    // The path is UTF-8 (argv/env are decoded as UTF-8 by the helpers), so
    // it is opened through the UTF-8 helper - plain std::ofstream would use
    // the ANSI code page on Windows and miss user names with umlauts.
    g_file = openOutputFileUtf8(g_path, std::ios::out | std::ios::trunc);
  }
}

void emitHelperEvent(const std::string &jsonLine) {
  std::lock_guard<std::mutex> lock(g_mutex);
  std::cout << jsonLine << std::endl;
  if (g_path.empty()) {
    return;
  }
  if (!g_file.is_open()) {
    g_file = openOutputFileUtf8(g_path, std::ios::out | std::ios::app);
  }
  if (g_file) {
    g_file << jsonLine << '\n';
    g_file.flush();
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

}  // namespace broadify::helper
