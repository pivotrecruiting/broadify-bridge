#include "util/json_utils.h"

#include <chrono>
#include <cstdlib>
#include <sstream>

namespace broadify::meeting {
namespace {

size_t findValueStart(const std::string &body, const std::string &field) {
  const std::string needle = "\"" + field + "\"";
  size_t pos = body.find(needle);
  if (pos == std::string::npos) {
    return std::string::npos;
  }
  pos = body.find(':', pos + needle.size());
  if (pos == std::string::npos) {
    return std::string::npos;
  }
  ++pos;
  while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t' || body[pos] == '\n' || body[pos] == '\r')) {
    ++pos;
  }
  return pos;
}

}  // namespace

uint64_t nowNs() {
  using clock = std::chrono::steady_clock;
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(clock::now().time_since_epoch()).count());
}

std::string jsonEscape(const std::string &value) {
  std::ostringstream out;
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        out << ch;
        break;
    }
  }
  return out.str();
}

std::string extractStringField(const std::string &body, const std::string &field) {
  size_t pos = findValueStart(body, field);
  if (pos == std::string::npos || pos >= body.size() || body[pos] != '"') {
    return "";
  }
  size_t end = pos + 1;
  bool escaped = false;
  for (; end < body.size(); ++end) {
    const char ch = body[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      continue;
    }
    if (ch == '"') {
      break;
    }
  }
  if (end >= body.size()) {
    return "";
  }
  return body.substr(pos + 1, end - pos - 1);
}

bool extractBoolField(const std::string &body, const std::string &field, bool fallback) {
  const size_t pos = findValueStart(body, field);
  if (pos == std::string::npos) {
    return fallback;
  }
  if (body.compare(pos, 4, "true") == 0) {
    return true;
  }
  if (body.compare(pos, 5, "false") == 0) {
    return false;
  }
  return fallback;
}

int extractIntField(const std::string &body, const std::string &field, int fallback) {
  const size_t pos = findValueStart(body, field);
  if (pos == std::string::npos) {
    return fallback;
  }
  char *end = nullptr;
  const long parsed = std::strtol(body.c_str() + pos, &end, 10);
  if (end == body.c_str() + pos) {
    return fallback;
  }
  return static_cast<int>(parsed);
}

double extractDoubleField(const std::string &body, const std::string &field, double fallback) {
  const size_t pos = findValueStart(body, field);
  if (pos == std::string::npos) {
    return fallback;
  }
  char *end = nullptr;
  const double parsed = std::strtod(body.c_str() + pos, &end);
  if (end == body.c_str() + pos) {
    return fallback;
  }
  return parsed;
}

std::string extractObjectField(const std::string &body, const std::string &field) {
  const size_t start = findValueStart(body, field);
  if (start == std::string::npos || start >= body.size() || body[start] != '{') {
    return "";
  }

  int depth = 0;
  bool inString = false;
  bool escaped = false;
  for (size_t pos = start; pos < body.size(); ++pos) {
    const char ch = body[pos];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = inString;
      continue;
    }
    if (ch == '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch == '{') {
      ++depth;
      continue;
    }
    if (ch == '}') {
      --depth;
      if (depth == 0) {
        return body.substr(start, pos - start + 1);
      }
    }
  }
  return "";
}

std::string okResponse(const std::string &id, const std::string &result) {
  return "{\"id\":\"" + jsonEscape(id) + "\",\"ok\":true,\"result\":" + result + "}\n";
}

std::string errorResponse(const std::string &id, const std::string &code, const std::string &message) {
  return "{\"id\":\"" + jsonEscape(id) + "\",\"ok\":false,\"error\":{\"code\":\"" +
         jsonEscape(code) + "\",\"message\":\"" + jsonEscape(message) + "\"}}\n";
}

}  // namespace broadify::meeting
