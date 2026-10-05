#include "util/json_utils.h"

#include <iostream>
#include <string>
#include <vector>

using broadify::meeting::extractStringArrayField;
using broadify::meeting::extractBoolField;
using broadify::meeting::extractDoubleField;
using broadify::meeting::extractIntField;
using broadify::meeting::extractStringField;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "json_utils_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;

  // Field names can also appear as string values before the actual key.
  {
    const std::string body =
        R"({"enabled":true,"source":"page","mode":"pip","page":3})";
    ok &= expect(extractIntField(body, "page", 0) == 3,
                 "value equal to later int key");
    ok &= expect(extractStringField(body, "mode") == "pip",
                 "mode string parsed");
    ok &= expect(extractStringField(body, "source") == "page",
                 "source string value parsed");
  }

  // Bool and double fields should also ignore earlier matching values.
  {
    ok &= expect(extractBoolField(R"({"label":"enabled","enabled":false})",
                                  "enabled", true) == false,
                 "bool key after matching string value");
    ok &= expect(extractDoubleField(R"({"note":"width","width":1.5})",
                                    "width", 0.0) == 1.5,
                 "double key after matching string value");
  }

  // Whitespace before the key/value colon is accepted.
  {
    ok &= expect(extractIntField(R"({"page" : 7})", "page", 0) == 7,
                 "whitespace before colon");
  }

  // A name that appears only as a string value must not be treated as a key.
  {
    ok &= expect(extractIntField(R"({"source":"page"})", "page", 9) == 9,
                 "string value only returns fallback");
  }

  // Plain array.
  {
    const auto values =
        extractStringArrayField(R"({"camera_stable_keys":["a","b","c"]})",
                                "camera_stable_keys");
    ok &= expect(values == std::vector<std::string>({"a", "b", "c"}),
                 "plain string array");
  }

  // Device symbolic links: commas, brackets and braces inside the quoted
  // elements must not split the array. Windows MF stable keys look like this;
  // on the wire JSON.stringify doubles every backslash, so the "\\?\" prefix
  // arrives as "\\\\?\\" and unescapes back to "\\?\".
  {
    const std::string body =
        R"({"camera_stable_keys":[)"
        R"("\\\\?\\usb#vid_046d&pid_0892&mi_00#7&1a2b,3c#{65e8773d}",)"
        R"("\\\\?\\usb#vid_1234#[bracketed]#{abcd}"]})";
    const auto values =
        extractStringArrayField(body, "camera_stable_keys");
    ok &= expect(values.size() == 2u, "two device keys parsed");
    ok &= expect(values.size() == 2u &&
                     values[0] ==
                         R"(\\?\usb#vid_046d&pid_0892&mi_00#7&1a2b,3c#{65e8773d})",
                 "comma/brace inside key survives");
    ok &= expect(values.size() == 2u &&
                     values[1] == R"(\\?\usb#vid_1234#[bracketed]#{abcd})",
                 "brackets inside key survive");
  }

  // Escaped quote and backslash inside an element.
  {
    const auto values = extractStringArrayField(
        R"({"k":["a\"b\\c"]})", "k");
    ok &= expect(values == std::vector<std::string>({"a\"b\\c"}),
                 "escaped quote and backslash");
  }

  // Whitespace between elements.
  {
    const auto values =
        extractStringArrayField("{\"k\": [ \"a\" , \"b\" ] }", "k");
    ok &= expect(values == std::vector<std::string>({"a", "b"}),
                 "whitespace tolerated");
  }

  // Empty array, absent field, and non-array value all yield empty.
  {
    ok &= expect(extractStringArrayField(R"({"k":[]})", "k").empty(),
                 "empty array");
    ok &= expect(extractStringArrayField(R"({"other":["a"]})", "k").empty(),
                 "absent field");
    ok &= expect(extractStringArrayField(R"({"k":"a"})", "k").empty(),
                 "non-array value");
  }

  return ok ? 0 : 1;
}
