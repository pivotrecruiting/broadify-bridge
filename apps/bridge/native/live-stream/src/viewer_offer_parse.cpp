#include "live_stream/viewer_offer_parse.h"

#include "helper_common/json_utils.h"

namespace broadify::live {

using broadify::helper::extractStringField;

namespace {

// Minimal array-of-objects scan for ice_servers: [{"url":..,"username":..,"credential":..},...].
// The bridge builds this payload (zod-validated), so a tolerant scanner is enough.
std::vector<std::string> splitTopLevelObjects(const std::string &array) {
  std::vector<std::string> out;
  int depth = 0;
  bool inString = false;
  size_t start = std::string::npos;
  for (size_t i = 0; i < array.size(); ++i) {
    const char ch = array[i];
    if (inString) {
      if (ch == '\\') {
        ++i;
      } else if (ch == '"') {
        inString = false;
      }
      continue;
    }
    if (ch == '"') {
      inString = true;
    } else if (ch == '{') {
      if (depth == 0) {
        start = i;
      }
      ++depth;
    } else if (ch == '}') {
      --depth;
      if (depth == 0 && start != std::string::npos) {
        out.push_back(array.substr(start, i - start + 1));
        start = std::string::npos;
      }
    }
  }
  return out;
}

std::string extractArrayField(const std::string &body, const std::string &field) {
  const std::string key = "\"" + field + "\"";
  size_t pos = body.find(key);
  if (pos == std::string::npos) {
    return "";
  }
  pos = body.find('[', pos + key.size());
  if (pos == std::string::npos) {
    return "";
  }
  int depth = 0;
  bool inString = false;
  for (size_t i = pos; i < body.size(); ++i) {
    const char ch = body[i];
    if (inString) {
      if (ch == '\\') {
        ++i;
      } else if (ch == '"') {
        inString = false;
      }
      continue;
    }
    if (ch == '"') {
      inString = true;
    } else if (ch == '[') {
      ++depth;
    } else if (ch == ']') {
      --depth;
      if (depth == 0) {
        return body.substr(pos, i - pos + 1);
      }
    }
  }
  return "";
}

}  // namespace

std::vector<IceServerSpec> parseIceServers(const std::string &body) {
  std::vector<IceServerSpec> servers;
  for (const std::string &object : splitTopLevelObjects(extractArrayField(body, "ice_servers"))) {
    IceServerSpec spec;
    spec.url = extractStringField(object, "url");
    spec.username = extractStringField(object, "username");
    spec.credential = extractStringField(object, "credential");
    if (!spec.url.empty()) {
      servers.push_back(spec);
    }
  }
  return servers;
}

}  // namespace broadify::live
