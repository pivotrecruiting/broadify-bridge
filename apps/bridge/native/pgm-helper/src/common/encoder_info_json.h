#pragma once

#include "live_stream/video_encoder.h"

#include <string>

namespace broadify::pgm {

/**
 * What the configured hardware encoder reports about itself, as JSON members
 * for `pgm_encoder_configured` and `pgm_status.encoder`. Every member starts
 * with a comma (the result is appended to an object that already has members)
 * and appears only when the encoder reports it:
 *
 *   "name"       product name (Windows: friendly name of the chosen encoder MFT)
 *   "vendor_id"  hardware vendor id (Windows: e.g. "VEN_10DE")
 *   "vendor"     "nvidia" | "amd" | "intel" | "unknown", derived from the two
 *                above by the rule the encoder ranks its candidates with
 *   "settings"   the settings that took effect, as the JSON object the encoder
 *                reports (Windows: rate control, forced keyframes, GOP, ...)
 *
 * VideoToolbox reports none of them, so the result is empty on macOS.
 * Settings that are not one well-formed, single-line JSON object are passed
 * on as the string member "settings_text" instead: the event line they end up
 * in must stay one parsable line.
 */
std::string encoderDetailJsonMembers(const live::EncoderInfo &info);

}  // namespace broadify::pgm
