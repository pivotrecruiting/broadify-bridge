#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace broadify::meeting {

std::string jsonEscape(const std::string &value);
std::string extractStringField(const std::string &body, const std::string &field);
// Parses a flat JSON string array ("field":["a","b",...]) into its unescaped
// elements. Quote- and escape-aware, so array elements may contain commas,
// brackets or quotes (camera stable keys are Windows device symbolic links
// with #, {, } and other punctuation). Returns empty when the field is absent
// or is not an array.
std::vector<std::string> extractStringArrayField(const std::string &body,
                                                  const std::string &field);
bool extractBoolField(const std::string &body, const std::string &field, bool fallback);
int extractIntField(const std::string &body, const std::string &field, int fallback);
double extractDoubleField(const std::string &body, const std::string &field, double fallback);
std::string extractObjectField(const std::string &body, const std::string &field);
std::string okResponse(const std::string &id, const std::string &result);
std::string errorResponse(const std::string &id, const std::string &code, const std::string &message);
uint64_t nowNs();

}  // namespace broadify::meeting
