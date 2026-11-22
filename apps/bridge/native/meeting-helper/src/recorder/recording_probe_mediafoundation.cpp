// Windows side of recording_probe.h. Mirrors the encoder enumeration of the
// PGM helper's --probe (pgm-helper/src/platform/platform_host_win.cpp): same
// category, flags and input type as the Media Foundation encoder itself
// (live-stream/src/mf_encoder.cpp), once per output codec.

#if defined(_WIN32)

#include "recorder/recording_probe.h"

#include "live_stream/mf_encoder_policy.h"
#include "util/path_utf8.h"

#include <windows.h>

#include <mfapi.h>
#include <mfobjects.h>
#include <mftransform.h>
#include <objbase.h>

#include <utility>
#include <vector>

namespace broadify::meeting {
namespace {

// The hardware encoder MFTs for one output subtype, appended in the order the
// program-stream encoder would try them (rankEncoderCandidates). Enumeration
// only: no transform is activated, so nothing is opened on the GPU. Hardware
// only: a software encoder MFT never shows up here. False when MFTEnumEx
// itself fails.
bool appendHardwareEncoders(const GUID &outputSubtype, RecordingCodec codec,
                            std::vector<RecordingEncoderInfo> &encoders) {
  MFT_REGISTER_TYPE_INFO inputType = {MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO outputType = {MFMediaType_Video, outputSubtype};
  IMFActivate **activates = nullptr;
  UINT32 count = 0;
  const HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
                               MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                               &inputType, &outputType, &activates, &count);
  if (FAILED(hr)) {
    return false;
  }
  std::vector<broadify::live::EncoderCandidateInfo> candidates;
  for (UINT32 index = 0; index < count; ++index) {
    IMFActivate *activate = activates[index];
    if (activate == nullptr) {
      continue;
    }
    broadify::live::EncoderCandidateInfo candidate;
    wchar_t *text = nullptr;
    UINT32 length = 0;
    if (SUCCEEDED(activate->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &text, &length)) && text != nullptr) {
      candidate.name = wideToUtf8(text);
      CoTaskMemFree(text);
    }
    text = nullptr;
    if (SUCCEEDED(activate->GetAllocatedString(MFT_ENUM_HARDWARE_VENDOR_ID_Attribute, &text, &length)) && text != nullptr) {
      candidate.vendorId = wideToUtf8(text);
      CoTaskMemFree(text);
    }
    activate->Release();
    candidates.push_back(std::move(candidate));
  }
  CoTaskMemFree(activates);
  for (const size_t index : broadify::live::rankEncoderCandidates(candidates)) {
    RecordingEncoderInfo info;
    info.codec = codec;
    info.name = candidates[index].name;
    info.vendor = broadify::live::encoderVendorName(broadify::live::classifyEncoderVendor(candidates[index]));
    encoders.push_back(std::move(info));
  }
  return true;
}

}  // namespace

// H.264 and HEVC only: Windows has no licensed ProRes encoder, so ProRes is
// never reported here. The probe is its own short-lived process, so COM and
// Media Foundation are started and released around the enumeration.
RecordingProbeResult probeRecordingEncoders() {
  RecordingProbeResult result;
  result.backend = "mediafoundation";
  const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com) && com != RPC_E_CHANGED_MODE) {
    return result;
  }
  if (SUCCEEDED(MFStartup(MF_VERSION))) {
    const bool h264 = appendHardwareEncoders(MFVideoFormat_H264, RecordingCodec::H264, result.encoders);
    const bool hevc = appendHardwareEncoders(MFVideoFormat_HEVC, RecordingCodec::Hevc, result.encoders);
    result.ok = h264 && hevc;
    MFShutdown();
  }
  if (SUCCEEDED(com)) {
    CoUninitialize();
  }
  return result;
}

}  // namespace broadify::meeting

#endif
