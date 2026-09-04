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

void appendUtf8(std::string &out, uint32_t codepoint) {
  if (codepoint <= 0x7fu) {
    out.push_back(static_cast<char>(codepoint));
  } else if (codepoint <= 0x7ffu) {
    out.push_back(static_cast<char>(0xc0u | (codepoint >> 6u)));
    out.push_back(static_cast<char>(0x80u | (codepoint & 0x3fu)));
  } else if (codepoint <= 0xffffu) {
    out.push_back(static_cast<char>(0xe0u | (codepoint >> 12u)));
    out.push_back(static_cast<char>(0x80u | ((codepoint >> 6u) & 0x3fu)));
    out.push_back(static_cast<char>(0x80u | (codepoint & 0x3fu)));
  } else {
    out.push_back(static_cast<char>(0xf0u | (codepoint >> 18u)));
    out.push_back(static_cast<char>(0x80u | ((codepoint >> 12u) & 0x3fu)));
    out.push_back(static_cast<char>(0x80u | ((codepoint >> 6u) & 0x3fu)));
    out.push_back(static_cast<char>(0x80u | (codepoint & 0x3fu)));
  }
}

int hexValue(char ch) {
  if (ch >= '0' && ch <= '9') {
    return ch - '0';
  }
  if (ch >= 'a' && ch <= 'f') {
    return ch - 'a' + 10;
  }
  if (ch >= 'A' && ch <= 'F') {
    return ch - 'A' + 10;
  }
  return -1;
}

std::string unescapeJsonString(const std::string &value) {
  std::string out;
  out.reserve(value.size());
  for (size_t index = 0; index < value.size(); ++index) {
    const char ch = value[index];
    if (ch != '\\' || index + 1u >= value.size()) {
      out.push_back(ch);
      continue;
    }
    const char escaped = value[++index];
    switch (escaped) {
      case '"':
      case '\\':
      case '/':
        out.push_back(escaped);
        break;
      case 'b':
        out.push_back('\b');
        break;
      case 'f':
        out.push_back('\f');
        break;
      case 'n':
        out.push_back('\n');
        break;
      case 'r':
        out.push_back('\r');
        break;
      case 't':
        out.push_back('\t');
        break;
      case 'u': {
        if (index + 4u >= value.size()) {
          return out;
        }
        uint32_t codepoint = 0;
        for (size_t digit = 0; digit < 4u; ++digit) {
          const int hex = hexValue(value[index + 1u + digit]);
          if (hex < 0) {
            return out;
          }
          codepoint = (codepoint << 4u) | static_cast<uint32_t>(hex);
        }
        index += 4u;
        appendUtf8(out, codepoint);
        break;
      }
      default:
        out.push_back(escaped);
        break;
    }
  }
  return out;
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
  return unescapeJsonString(body.substr(pos + 1, end - pos - 1));
}

std::vector<std::string> extractStringArrayField(const std::string &body,
                                                  const std::string &field) {
  std::vector<std::string> values;
  size_t pos = findValueStart(body, field);
  if (pos == std::string::npos || pos >= body.size() || body[pos] != '[') {
    return values;
  }
  ++pos;  // step past '['
  while (pos < body.size()) {
    while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t' ||
                                 body[pos] == '\n' || body[pos] == '\r' ||
                                 body[pos] == ',')) {
      ++pos;
    }
    if (pos >= body.size() || body[pos] == ']') {
      break;
    }
    if (body[pos] != '"') {
      // Only string arrays are supported; anything else ends parsing.
      break;
    }
    const size_t stringStart = pos + 1u;
    size_t end = stringStart;
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
      break;  // unterminated string
    }
    values.push_back(
        unescapeJsonString(body.substr(stringStart, end - stringStart)));
    pos = end + 1u;
  }
  return values;
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
