#include "live_stream/mf_encoder_policy.h"

#include <algorithm>
#include <cctype>
#include <cstdio>

namespace broadify::live {
namespace {

std::string lowered(const std::string &value) {
  std::string out = value;
  std::transform(out.begin(), out.end(), out.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

bool contains(const std::string &haystack, const char *needle) { return haystack.find(needle) != std::string::npos; }

// Lower rank is tried first.
int vendorRank(EncoderVendor vendor) {
  switch (vendor) {
    case EncoderVendor::Nvidia:
      return 0;
    case EncoderVendor::Amd:
      return 1;
    case EncoderVendor::Intel:
      return 2;
    case EncoderVendor::Unknown:
      break;
  }
  return 3;
}

uint32_t kbpsToBps(uint32_t kbps) {
  const uint64_t bps = static_cast<uint64_t>(kbps) * 1000u;
  return bps > 0xFFFFFFFFull ? 0xFFFFFFFFu : static_cast<uint32_t>(bps);
}

std::string hex32(uint32_t value) {
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "0x%08X", static_cast<unsigned int>(value));
  return buffer;
}

}  // namespace

EncoderVendor parseEncoderVendor(const std::string &value) {
  const std::string v = lowered(value);
  if (v == "nvidia") {
    return EncoderVendor::Nvidia;
  }
  if (v == "intel") {
    return EncoderVendor::Intel;
  }
  if (v == "amd") {
    return EncoderVendor::Amd;
  }
  return EncoderVendor::Unknown;
}

const char *encoderVendorName(EncoderVendor vendor) {
  switch (vendor) {
    case EncoderVendor::Nvidia:
      return "nvidia";
    case EncoderVendor::Amd:
      return "amd";
    case EncoderVendor::Intel:
      return "intel";
    case EncoderVendor::Unknown:
      break;
  }
  return "unknown";
}

EncoderVendor classifyEncoderVendor(const EncoderCandidateInfo &candidate) {
  // PCI vendor ids as the MFT reports them ("VEN_10DE").
  const std::string id = lowered(candidate.vendorId);
  if (contains(id, "10de")) {
    return EncoderVendor::Nvidia;
  }
  if (contains(id, "1002") || contains(id, "1022")) {
    return EncoderVendor::Amd;
  }
  if (contains(id, "8086")) {
    return EncoderVendor::Intel;
  }
  const std::string name = lowered(candidate.name);
  if (contains(name, "nvidia")) {
    return EncoderVendor::Nvidia;
  }
  if (contains(name, "amd") || contains(name, "radeon")) {
    return EncoderVendor::Amd;
  }
  if (contains(name, "intel")) {
    return EncoderVendor::Intel;
  }
  return EncoderVendor::Unknown;
}

std::vector<size_t> rankEncoderCandidates(const std::vector<EncoderCandidateInfo> &candidates, EncoderVendor preferred) {
  std::vector<std::pair<int, size_t>> ranked;
  ranked.reserve(candidates.size());
  for (size_t i = 0; i < candidates.size(); ++i) {
    const EncoderVendor vendor = classifyEncoderVendor(candidates[i]);
    const bool isPreferred = preferred != EncoderVendor::Unknown && vendor == preferred;
    ranked.emplace_back(isPreferred ? -1 : vendorRank(vendor), i);
  }
  std::stable_sort(ranked.begin(), ranked.end(),
                   [](const std::pair<int, size_t> &a, const std::pair<int, size_t> &b) { return a.first < b.first; });
  std::vector<size_t> order;
  order.reserve(ranked.size());
  for (const std::pair<int, size_t> &entry : ranked) {
    order.push_back(entry.second);
  }
  return order;
}

const char *rateControlModeName(RateControlMode mode) {
  switch (mode) {
    case RateControlMode::PeakConstrainedVbr:
      return "peak_vbr";
    case RateControlMode::Cbr:
      return "cbr";
    case RateControlMode::UnconstrainedVbr:
      break;
  }
  return "vbr";
}

RateControlStep rateControlForBitrate(RateControlMode mode, uint32_t bitrateKbps, uint32_t maxBitrateKbps) {
  RateControlStep step;
  step.mode = mode;
  step.meanBitrateBps = kbpsToBps(bitrateKbps);
  const uint32_t peakBps = kbpsToBps(std::max(bitrateKbps, maxBitrateKbps));
  switch (mode) {
    case RateControlMode::PeakConstrainedVbr:
      // Hard cap per second, like the VideoToolbox data-rate limit: the peak rate over a 1 s buffer.
      step.maxBitrateBps = peakBps;
      step.bufferBits = peakBps;
      break;
    case RateControlMode::Cbr:
      // CBR at the mean stays below the cap by construction.
      step.bufferBits = step.meanBitrateBps;
      break;
    case RateControlMode::UnconstrainedVbr:
      break;
  }
  return step;
}

std::vector<RateControlStep> planRateControl(const EncodeTarget &target) {
  std::vector<RateControlStep> steps;
  if (!target.hardRateLimit) {
    // Archive: the mean alone; a hard 1 s cap would starve complex scenes.
    steps.push_back(rateControlForBitrate(RateControlMode::UnconstrainedVbr, target.bitrateKbps, target.maxBitrateKbps));
  }
  steps.push_back(rateControlForBitrate(RateControlMode::PeakConstrainedVbr, target.bitrateKbps, target.maxBitrateKbps));
  steps.push_back(rateControlForBitrate(RateControlMode::Cbr, target.bitrateKbps, target.maxBitrateKbps));
  return steps;
}

EncoderAttributePlan planEncoderAttributes(const EncodeTarget &target) {
  EncoderAttributePlan plan;
  // H.264 hardware encoders want even dimensions.
  plan.width = std::max<uint32_t>(target.width & ~1u, 16);
  plan.height = std::max<uint32_t>(target.height & ~1u, 16);
  plan.fpsNum = target.fpsNum > 0 ? target.fpsNum : 30;
  plan.fpsDen = target.fpsDen > 0 ? target.fpsDen : 1;
  const double fps = static_cast<double>(plan.fpsNum) / static_cast<double>(plan.fpsDen);
  plan.profileIdc = target.h264Profile == H264Profile::High ? 100u : 77u;
  // Same rule as the VideoToolbox encoder: MaxKeyFrameInterval = fps * gopSeconds.
  plan.gopFrames = std::max<uint32_t>(1, static_cast<uint32_t>(fps * static_cast<double>(target.gopSeconds)));
  plan.fallbackGopFrames = std::max<uint32_t>(1, std::min(plan.gopFrames, static_cast<uint32_t>(fps)));
  plan.bFrames = 0;
  plan.lowLatency = true;
  plan.cabac = true;
  plan.qualityVsSpeed = target.prioritizeSpeed ? 33u : 67u;
  plan.frameDurationHns =
      static_cast<int64_t>(10'000'000ull * static_cast<uint64_t>(plan.fpsDen) / static_cast<uint64_t>(plan.fpsNum));
  plan.rateControl = planRateControl(target);
  return plan;
}

uint32_t gopFramesFor(const EncoderAttributePlan &plan, bool forceKeyframeSupported) {
  return forceKeyframeSupported ? plan.gopFrames : plan.fallbackGopFrames;
}

std::string formatEncoderUnavailable(const std::vector<EncoderAttempt> &attempts, uint32_t enumerationHresult) {
  if (attempts.empty()) {
    return "No hardware H.264 encoder is available (no hardware encoder MFT found, MFTEnumEx " +
           hex32(enumerationHresult) + ").";
  }
  std::string message = "No hardware H.264 encoder could be configured (tried ";
  for (size_t i = 0; i < attempts.size(); ++i) {
    if (i > 0) {
      message += "; ";
    }
    message += attempts[i].name.empty() ? std::string("unnamed encoder") : attempts[i].name;
    message += ": " + attempts[i].stage + " " + hex32(attempts[i].hresult);
  }
  message += ").";
  return message;
}

std::string formatEncoderSettings(const std::vector<std::pair<std::string, std::string>> &settings) {
  std::string json = "{";
  for (size_t i = 0; i < settings.size(); ++i) {
    if (i > 0) {
      json += ",";
    }
    json += "\"" + settings[i].first + "\":" + settings[i].second;
  }
  json += "}";
  return json;
}

CaptureTimestampMap::CaptureTimestampMap(size_t capacity) : capacity_(capacity > 0 ? capacity : 1) {}

int64_t CaptureTimestampMap::push(uint64_t captureNs) {
  const int64_t sampleTime = sampleTimeFor(captureNs);
  if (entries_.size() >= capacity_) {
    entries_.pop_front();
  }
  entries_.emplace_back(sampleTime, captureNs);
  return sampleTime;
}

uint64_t CaptureTimestampMap::take(int64_t sampleTimeHns) {
  for (size_t i = 0; i < entries_.size(); ++i) {
    if (entries_[i].first == sampleTimeHns) {
      const uint64_t captureNs = entries_[i].second;
      entries_.erase(entries_.begin(), entries_.begin() + static_cast<std::ptrdiff_t>(i) + 1);
      return captureNs;
    }
  }
  if (!entries_.empty()) {
    const uint64_t captureNs = entries_.front().second;
    entries_.pop_front();
    return captureNs;
  }
  return sampleTimeHns > 0 ? static_cast<uint64_t>(sampleTimeHns) * 100u : 0u;
}

void CaptureTimestampMap::clear() { entries_.clear(); }

}  // namespace broadify::live
