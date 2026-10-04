#include "capture/screen_capture_source.h"

#include "util/json_utils.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <sstream>

namespace broadify::meeting {
namespace {

std::string nullableString(const std::string &value) {
  return value.empty() ? "null" : "\"" + jsonEscape(value) + "\"";
}

uint32_t evenAtLeastTwo(uint32_t value) {
  if (value < 2u) {
    return 2u;
  }
  return value % 2u == 0u ? value : value - 1u;
}

bool isHex(char ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') ||
         (ch >= 'A' && ch <= 'F');
}

}  // namespace

std::string screenSourceToJson(const ScreenSourceInfo &source) {
  std::ostringstream out;
  out << "{\"source_id\":\"" << jsonEscape(source.sourceId)
      << "\",\"kind\":\"" << jsonEscape(source.kind)
      << "\",\"title\":\"" << jsonEscape(source.title)
      << "\",\"app_name\":" << nullableString(source.appName)
      << ",\"width\":" << source.width
      << ",\"height\":" << source.height
      << ",\"primary\":" << (source.primary ? "true" : "false")
      << ",\"active\":" << (source.active ? "true" : "false") << "}";
  return out.str();
}

std::string screenSourcesToJson(const std::vector<ScreenSourceInfo> &sources) {
  std::ostringstream out;
  out << "[";
  for (size_t i = 0; i < sources.size(); ++i) {
    if (i > 0u) {
      out << ",";
    }
    out << screenSourceToJson(sources[i]);
  }
  out << "]";
  return out.str();
}

std::string screenCapabilitiesToJson(const ScreenCaptureCapabilities &capabilities) {
  std::ostringstream out;
  out << "{\"supported\":" << (capabilities.supported ? "true" : "false")
      << ",\"system_picker\":" << (capabilities.systemPicker ? "true" : "false")
      << ",\"enumeration\":" << (capabilities.enumeration ? "true" : "false")
      << ",\"permission_status\":\"" << jsonEscape(capabilities.permissionStatus)
      << "\",\"unsupported_reason\":"
      << nullableString(capabilities.unsupportedReason) << "}";
  return out.str();
}

CaptureSize clampScreenCaptureSize(uint32_t srcW, uint32_t srcH,
                                   uint32_t maxW, uint32_t maxH) {
  if (srcW == 0u || srcH == 0u) {
    return {};
  }
  const uint32_t targetMaxW = maxW < 2u ? 2u : maxW;
  const uint32_t targetMaxH = maxH < 2u ? 2u : maxH;
  double scale = std::min(static_cast<double>(targetMaxW) / srcW,
                          static_cast<double>(targetMaxH) / srcH);
  scale = std::min(scale, 1.0);
  CaptureSize result;
  result.width =
      evenAtLeastTwo(static_cast<uint32_t>(std::round(srcW * scale)));
  result.height =
      evenAtLeastTwo(static_cast<uint32_t>(std::round(srcH * scale)));
  if (result.width > targetMaxW) {
    result.width = evenAtLeastTwo(targetMaxW);
  }
  if (result.height > targetMaxH) {
    result.height = evenAtLeastTwo(targetMaxH);
  }
  return result;
}

uint32_t selectCaptureMipLevel(uint32_t srcW, uint32_t srcH,
                               uint32_t minW, uint32_t minH) {
  uint32_t level = 0u;
  while (srcW / 2u >= minW && srcH / 2u >= minH && srcW >= 2u &&
         srcH >= 2u) {
    srcW /= 2u;
    srcH /= 2u;
    ++level;
  }
  return level;
}

bool parseScreenSourceId(const std::string &id, std::string &kind,
                         uint64_t &handle) {
  const size_t colon = id.find(':');
  if (colon == std::string::npos || colon == 0u) {
    return false;
  }
  const std::string parsedKind = id.substr(0, colon);
  if (parsedKind != "monitor" && parsedKind != "window" &&
      parsedKind != "display") {
    return false;
  }
  const std::string prefix = "0x";
  if (id.compare(colon + 1u, prefix.size(), prefix) != 0) {
    return false;
  }
  const size_t hexStart = colon + 1u + prefix.size();
  if (hexStart >= id.size()) {
    return false;
  }
  for (size_t i = hexStart; i < id.size(); ++i) {
    if (!isHex(id[i])) {
      return false;
    }
  }
  char *end = nullptr;
  const unsigned long long parsed =
      std::strtoull(id.c_str() + hexStart, &end, 16);
  if (end == id.c_str() + hexStart || *end != '\0') {
    return false;
  }
  kind = parsedKind;
  handle = static_cast<uint64_t>(parsed);
  return true;
}

}  // namespace broadify::meeting
