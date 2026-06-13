#pragma once

#include <cstdint>
#include <string>

namespace broadify::meeting {

std::string jsonEscape(const std::string &value);
std::string extractStringField(const std::string &body, const std::string &field);
bool extractBoolField(const std::string &body, const std::string &field, bool fallback);
int extractIntField(const std::string &body, const std::string &field, int fallback);
double extractDoubleField(const std::string &body, const std::string &field, double fallback);
std::string extractObjectField(const std::string &body, const std::string &field);
std::string okResponse(const std::string &id, const std::string &result);
std::string errorResponse(const std::string &id, const std::string &code, const std::string &message);
uint64_t nowNs();

}  // namespace broadify::meeting
