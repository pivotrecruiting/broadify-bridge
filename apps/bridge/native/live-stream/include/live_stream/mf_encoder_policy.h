#pragma once

#include "live_stream/bitrate_ladder.h"

#include <cstddef>
#include <cstdint>
#include <deque>
#include <string>
#include <utility>
#include <vector>

namespace broadify::live {

/**
 * Decisions of the Media Foundation hardware encoder (ADR-0009) that need no
 * Windows API: which enumerated encoder MFT to try first, which rate control
 * to ask for, which attributes an EncodeTarget turns into and how a failed
 * search is reported. Pure, so it is tested on every platform;
 * `mf_encoder.cpp` only executes these plans.
 */

enum class EncoderVendor { Unknown, Nvidia, Amd, Intel };

/** One enumerated encoder MFT: friendly name and MFT_ENUM_HARDWARE_VENDOR_ID_Attribute (e.g. "VEN_10DE"). */
struct EncoderCandidateInfo {
  std::string name;
  std::string vendorId;
};

/** BRIDGE_PGM_ENCODER_VENDOR value ("nvidia" | "intel" | "amd", any case); anything else is Unknown (no preference). */
EncoderVendor parseEncoderVendor(const std::string &value);
const char *encoderVendorName(EncoderVendor vendor);

/** Vendor of a candidate from its PCI vendor id, falling back to the friendly name. */
EncoderVendor classifyEncoderVendor(const EncoderCandidateInfo &candidate);

/**
 * Order in which the candidates are tried, as indices into `candidates`:
 * discrete GPUs (NVIDIA, AMD) before integrated ones (Intel), unknown vendors
 * last; the enumeration order (MFT_ENUM_FLAG_SORTANDFILTER merit) is kept
 * within a class. `preferred` moves that vendor's encoders to the front; the
 * others stay as fallbacks, so the chosen name always has to be read back.
 */
std::vector<size_t> rankEncoderCandidates(const std::vector<EncoderCandidateInfo> &candidates,
                                          EncoderVendor preferred = EncoderVendor::Unknown);

enum class RateControlMode { PeakConstrainedVbr, Cbr, UnconstrainedVbr };
const char *rateControlModeName(RateControlMode mode);  // "peak_vbr" | "cbr" | "vbr"

/** One rate-control setup; `maxBitrateBps` / `bufferBits` of 0 are not set on the encoder. */
struct RateControlStep {
  RateControlMode mode = RateControlMode::Cbr;
  uint32_t meanBitrateBps = 0;
  uint32_t maxBitrateBps = 0;
  uint32_t bufferBits = 0;
};

/**
 * Rate-control setups to try in order; the first one the encoder accepts wins.
 * Preview (hardRateLimit): peak-constrained VBR with the ladder's mean and
 * max and a 1 s buffer, else CBR at the mean (never above the cap). Archive:
 * unconstrained VBR at the mean, else peak-constrained VBR, else CBR.
 */
std::vector<RateControlStep> planRateControl(const EncodeTarget &target);

/** The numbers of `mode` for a bitrate change at run time (same rules as planRateControl). */
RateControlStep rateControlForBitrate(RateControlMode mode, uint32_t bitrateKbps, uint32_t maxBitrateKbps);

struct EncoderAttributePlan {
  uint32_t width = 0;   // even; odd targets lose their last column/row
  uint32_t height = 0;
  uint32_t fpsNum = 30;
  uint32_t fpsDen = 1;
  uint32_t profileIdc = 77;       // 77 Main, 100 High (the eAVEncH264VProfile values)
  uint32_t gopFrames = 60;        // fps * gopSeconds
  uint32_t fallbackGopFrames = 30;  // fps * 1 s, used when the encoder cannot force a keyframe
  uint32_t bFrames = 0;
  bool lowLatency = true;
  bool cabac = true;
  uint32_t qualityVsSpeed = 33;   // 0 fastest .. 100 best
  int64_t frameDurationHns = 333333;
  std::vector<RateControlStep> rateControl;
};

/** Everything `mf_encoder.cpp` sets on the MFT for one EncodeTarget. */
EncoderAttributePlan planEncoderAttributes(const EncodeTarget &target);

/** GOP length to set: the plan's GOP, or 1 s when keyframes cannot be forced (PLI recovery within a second). */
uint32_t gopFramesFor(const EncoderAttributePlan &plan, bool forceKeyframeSupported);

/** One encoder MFT that could not be used: where it failed and with which HRESULT. */
struct EncoderAttempt {
  std::string name;
  std::string stage;
  uint32_t hresult = 0;
};

/** Message for `encoder_unavailable`: the tried encoders with stage and HRESULT, or the empty enumeration. */
std::string formatEncoderUnavailable(const std::vector<EncoderAttempt> &attempts, uint32_t enumerationHresult);

/** JSON object from key / raw-JSON-value pairs, in order (EncoderInfo::settings). Keys and values are not escaped. */
std::string formatEncoderSettings(const std::vector<std::pair<std::string, std::string>> &settings);

/**
 * Maps encoder output back to the capture timestamp of its input. Sample
 * times are 100 ns units, so the nanosecond value cannot be recomputed; with
 * no B-frames the output order equals the input order. Not thread-safe.
 */
class CaptureTimestampMap {
 public:
  explicit CaptureTimestampMap(size_t capacity = 64);
  /** Remembers a submitted frame and returns its sample time (100 ns units). */
  int64_t push(uint64_t captureNs);
  /**
   * Capture time of the output with `sampleTimeHns`; entries older than the
   * match are dropped (their frames never came out). Without a match (an
   * encoder that rewrites sample times, or a negative time) the oldest
   * pending entry is used; with nothing pending the sample time itself.
   */
  uint64_t take(int64_t sampleTimeHns);
  void clear();
  size_t pending() const { return entries_.size(); }

  static int64_t sampleTimeFor(uint64_t captureNs) { return static_cast<int64_t>(captureNs / 100u); }

 private:
  size_t capacity_;
  std::deque<std::pair<int64_t, uint64_t>> entries_;
};

}  // namespace broadify::live
