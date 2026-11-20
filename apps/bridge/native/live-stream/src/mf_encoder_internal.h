#pragma once

// Internal seam of the Media Foundation encoder (mf_encoder.cpp): the encoder
// is built around a candidate enumerator so tests can hand it an in-test MFT.
// Production code never includes this header - helpers go through
// createHardwareEncoder(), which only ever enumerates hardware encoder MFTs
// (ADR-0009; scripts/pgm-mf-encoder-contract.test.cjs pins both).

#if defined(_WIN32)

#include "live_stream/video_encoder.h"

#include <windows.h>

#include <mftransform.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace broadify::live {

/** One encoder MFT the encoder may try, in enumeration order. */
struct MfEncoderCandidate {
  std::string name;      // MFT_FRIENDLY_NAME_Attribute
  std::string vendorId;  // MFT_ENUM_HARDWARE_VENDOR_ID_Attribute
  bool hardware = true;  // reported as EncoderInfo::hardware
  /** Creates the transform (IMFActivate::ActivateObject). Called on the encoder thread. */
  std::function<HRESULT(IMFTransform **)> activate;
  /** Releases what `activate` created beyond the transform (IMFActivate::ShutdownObject); may be empty. */
  std::function<void()> shutdown;
};

using MfEncoderEnumerator = std::function<HRESULT(std::vector<MfEncoderCandidate> &)>;

/** The production enumerator: hardware H.264 encoder MFTs with NV12 input, nothing else. */
HRESULT enumerateHardwareH264Encoders(std::vector<MfEncoderCandidate> &candidates);

/**
 * The encoder on top of an arbitrary enumerator. `preferredVendor` is the
 * BRIDGE_PGM_ENCODER_VENDOR value ("" = none). Tests only.
 */
std::unique_ptr<VideoEncoder> createMediaFoundationEncoder(MfEncoderEnumerator enumerator,
                                                           const std::string &preferredVendor);

struct MfEncoderStats {
  uint64_t received = 0;       // frames accepted by encode()
  uint64_t dropped = 0;        // replaced in the mailbox before the MFT asked for input, or refused by it
  uint64_t rejected = 0;       // frames encode() could not turn into an NV12 sample
  uint64_t submitted = 0;      // ProcessInput succeeded
  uint64_t encoded = 0;        // access units handed to onAccessUnit
  uint64_t forcedKeyframes = 0;
  uint64_t streamChanges = 0;  // MF_E_TRANSFORM_STREAM_CHANGE renegotiations
  uint64_t drains = 0;         // completed flush() drains
  uint64_t errors = 0;         // failed ProcessInput / ProcessOutput calls and malformed output
};

/** Counters of an encoder made by createMediaFoundationEncoder / createHardwareEncoder; zeros for any other. */
MfEncoderStats mediaFoundationEncoderStats(const VideoEncoder &encoder);

}  // namespace broadify::live

#endif  // _WIN32
