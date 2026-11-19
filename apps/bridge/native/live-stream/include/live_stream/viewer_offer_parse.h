#pragma once

#include "live_stream/viewer_types.h"

#include <string>
#include <vector>

namespace broadify::live {

/**
 * Parses the `ice_servers` array of an offer payload
 * ([{"url":..,"username":..,"credential":..},...]); tolerant of missing
 * credentials. The bridge builds this payload (zod-validated), so a minimal
 * scanner is enough.
 */
std::vector<IceServerSpec> parseIceServers(const std::string &body);

}  // namespace broadify::live
