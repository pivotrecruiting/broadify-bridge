#include "common/encoder_info_json.h"

#include "helper_common/json_utils.h"
#include "live_stream/mf_encoder_policy.h"

#include <cstdio>

namespace broadify::pgm {
namespace {

// A JSON string literal. jsonEscape covers quotes, backslashes and the usual
// whitespace escapes; a name that comes from a driver may contain any other
// control character too, and those are written as \u00XX.
std::string jsonString(const std::string &value) {
  std::string out = "\"";
  for (const char ch : broadify::helper::jsonEscape(value)) {
    if (static_cast<unsigned char>(ch) < 0x20) {
      char buffer[8];
      std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned int>(static_cast<unsigned char>(ch)));
      out += buffer;
    } else {
      out.push_back(ch);
    }
  }
  out.push_back('"');
  return out;
}

// Strict JSON reader (RFC 8259) with one restriction: no line breaks between
// tokens, because helper events are one JSON object per line. It only answers
// whether a text may be embedded into an event line as it is.
class JsonReader {
 public:
  explicit JsonReader(const std::string &text) : cursor_(text.data()), end_(text.data() + text.size()) {}

  /** One object on a single line, with nothing but blanks around it. */
  bool isObject() {
    skipSpace();
    if (cursor_ == end_ || *cursor_ != '{' || !value(0)) {
      return false;
    }
    skipSpace();
    return cursor_ == end_;
  }

 private:
  static constexpr int kMaxDepth = 16;

  void skipSpace() {
    while (cursor_ != end_ && (*cursor_ == ' ' || *cursor_ == '\t')) {
      ++cursor_;
    }
  }

  bool take(char expected) {
    if (cursor_ == end_ || *cursor_ != expected) {
      return false;
    }
    ++cursor_;
    return true;
  }

  bool literal(const char *word) {
    for (; *word != '\0'; ++word) {
      if (!take(*word)) {
        return false;
      }
    }
    return true;
  }

  bool digits() {
    const char *start = cursor_;
    while (cursor_ != end_ && *cursor_ >= '0' && *cursor_ <= '9') {
      ++cursor_;
    }
    return cursor_ != start;
  }

  bool number() {
    take('-');
    // No leading zeros: a zero stands alone before the fraction or exponent.
    if (!take('0') && !digits()) {
      return false;
    }
    if (take('.') && !digits()) {
      return false;
    }
    if (take('e') || take('E')) {
      if (!take('+')) {
        take('-');
      }
      return digits();
    }
    return true;
  }

  bool string() {
    if (!take('"')) {
      return false;
    }
    while (cursor_ != end_) {
      const unsigned char ch = static_cast<unsigned char>(*cursor_++);
      if (ch == '"') {
        return true;
      }
      if (ch < 0x20) {
        return false;
      }
      if (ch != '\\') {
        continue;
      }
      if (cursor_ == end_) {
        return false;
      }
      switch (*cursor_++) {
        case '"':
        case '\\':
        case '/':
        case 'b':
        case 'f':
        case 'n':
        case 'r':
        case 't':
          break;
        case 'u':
          for (int digit = 0; digit < 4; ++digit) {
            if (cursor_ == end_) {
              return false;
            }
            const char hex = *cursor_++;
            if (!((hex >= '0' && hex <= '9') || (hex >= 'a' && hex <= 'f') || (hex >= 'A' && hex <= 'F'))) {
              return false;
            }
          }
          break;
        default:
          return false;
      }
    }
    return false;
  }

  bool value(int depth) {
    skipSpace();
    if (cursor_ == end_) {
      return false;
    }
    switch (*cursor_) {
      case '{':
        return depth < kMaxDepth && object(depth);
      case '[':
        return depth < kMaxDepth && array(depth);
      case '"':
        return string();
      case 't':
        return literal("true");
      case 'f':
        return literal("false");
      case 'n':
        return literal("null");
      default:
        return number();
    }
  }

  bool object(int depth) {
    ++cursor_;  // '{'
    skipSpace();
    if (take('}')) {
      return true;
    }
    for (;;) {
      skipSpace();
      if (!string()) {
        return false;
      }
      skipSpace();
      if (!take(':') || !value(depth + 1)) {
        return false;
      }
      skipSpace();
      if (take('}')) {
        return true;
      }
      if (!take(',')) {
        return false;
      }
    }
  }

  bool array(int depth) {
    ++cursor_;  // '['
    skipSpace();
    if (take(']')) {
      return true;
    }
    for (;;) {
      if (!value(depth + 1)) {
        return false;
      }
      skipSpace();
      if (take(']')) {
        return true;
      }
      if (!take(',')) {
        return false;
      }
    }
  }

  const char *cursor_;
  const char *end_;
};

}  // namespace

std::string encoderDetailJsonMembers(const live::EncoderInfo &info) {
  std::string out;
  if (!info.name.empty()) {
    out += ",\"name\":" + jsonString(info.name);
  }
  if (!info.vendorId.empty()) {
    out += ",\"vendor_id\":" + jsonString(info.vendorId);
  }
  if (!info.name.empty() || !info.vendorId.empty()) {
    const live::EncoderVendor vendor = live::classifyEncoderVendor(live::EncoderCandidateInfo{info.name, info.vendorId});
    out += ",\"vendor\":\"" + std::string(live::encoderVendorName(vendor)) + "\"";
  }
  if (!info.settings.empty()) {
    if (JsonReader(info.settings).isObject()) {
      out += ",\"settings\":" + info.settings;
    } else {
      out += ",\"settings_text\":" + jsonString(info.settings);
    }
  }
  return out;
}

}  // namespace broadify::pgm
