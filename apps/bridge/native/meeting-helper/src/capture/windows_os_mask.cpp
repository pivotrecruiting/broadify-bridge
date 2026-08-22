#include "capture/windows_os_mask.h"

#if defined(_WIN32)
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mfcaptureengine.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl/client.h>

#include <algorithm>
#include <mutex>
#include <unordered_map>
#include <vector>
#endif

namespace broadify::meeting {
#if defined(_WIN32)
namespace {

using Microsoft::WRL::ComPtr;

struct SourceMaskState {
  ComPtr<IMFMediaSource> source;
  ComPtr<IMFExtendedCameraControl> control;
  WindowsOsMaskProbeResult probe;
};

std::mutex g_maskSourcesMutex;
std::unordered_map<IMFMediaSource *, SourceMaskState> g_maskSources;
bool g_osMaskEnabled = false;

WindowsOsMaskProbeResult probeSource(IMFMediaSource *source,
                                      IMFExtendedCameraControl **controlOut) {
  WindowsOsMaskProbeResult result;
  result.reason = "media_source_missing";
  if (controlOut != nullptr) {
    *controlOut = nullptr;
  }
  if (source == nullptr) {
    return result;
  }

  ComPtr<IMFGetService> getService;
  HRESULT hr = source->QueryInterface(IID_PPV_ARGS(&getService));
  if (FAILED(hr)) {
    result.reason = "get_service_missing";
    return result;
  }

  ComPtr<IMFExtendedCameraController> controller;
  hr = getService->GetService(GUID_NULL, IID_PPV_ARGS(&controller));
  if (FAILED(hr) || !controller) {
    result.reason = "extended_camera_controller_missing";
    return result;
  }

  ComPtr<IMFExtendedCameraControl> control;
  hr = controller->GetExtendedCameraControl(
      MF_CAPTURE_ENGINE_MEDIASOURCE,
      KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION,
      &control);
  if (FAILED(hr) || !control) {
    result.reason = "background_segmentation_property_missing";
    return result;
  }

  result.propertyPresent = true;
  const ULONGLONG caps = control->GetCapabilities();
  result.maskCapabilityPresent =
      (caps & KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK) != 0ull;
  result.reason = result.maskCapabilityPresent
                      ? "mask_capability_present"
                      : "mask_capability_missing";
  if (controlOut != nullptr) {
    *controlOut = control.Detach();
  }
  return result;
}

template <typename RectT>
OsMaskRect rectFromKs(const RectT &rect) {
  return OsMaskRect{
      static_cast<uint32_t>(std::max<LONG>(0, rect.left)),
      static_cast<uint32_t>(std::max<LONG>(0, rect.top)),
      static_cast<uint32_t>(std::max<LONG>(0, rect.right - rect.left)),
      static_cast<uint32_t>(std::max<LONG>(0, rect.bottom - rect.top)),
  };
}

}  // namespace
#endif

WindowsOsMaskProbeResult probeWindowsOsBackgroundMask() {
#if defined(_WIN32)
  std::lock_guard<std::mutex> lock(g_maskSourcesMutex);
  for (const auto &entry : g_maskSources) {
    if (entry.second.probe.propertyPresent) {
      return entry.second.probe;
    }
  }
  WindowsOsMaskProbeResult result;
  result.reason = "no_attached_capture_source";
  return result;
#else
  return WindowsOsMaskProbeResult{};
#endif
}

void configureWindowsOsBackgroundSegmentation(bool enableMask) {
#if defined(_WIN32)
  std::lock_guard<std::mutex> lock(g_maskSourcesMutex);
  g_osMaskEnabled = enableMask;
  for (auto &entry : g_maskSources) {
    IMFExtendedCameraControl *control = entry.second.control.Get();
    if (control == nullptr) {
      continue;
    }
    const ULONGLONG flags =
        enableMask ? KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK
                   : KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_OFF;
    if (SUCCEEDED(control->SetFlags(flags))) {
      (void)control->CommitSettings();
    }
  }
#else
  (void)enableMask;
#endif
}

#if defined(_WIN32)
WindowsOsMaskProbeResult attachWindowsOsBackgroundMaskSource(
    IMFMediaSource *source) {
  ComPtr<IMFExtendedCameraControl> control;
  WindowsOsMaskProbeResult probe = probeSource(source, &control);
  if (source != nullptr) {
    bool enableMask = false;
    {
      std::lock_guard<std::mutex> lock(g_maskSourcesMutex);
      enableMask = g_osMaskEnabled;
    }
    if (probe.propertyPresent && control) {
      const ULONGLONG flags =
          enableMask ? KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK
                     : KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_OFF;
      if (SUCCEEDED(control->SetFlags(flags))) {
        (void)control->CommitSettings();
      }
    }
    SourceMaskState state;
    state.source = source;
    state.control = std::move(control);
    state.probe = probe;
    std::lock_guard<std::mutex> lock(g_maskSourcesMutex);
    g_maskSources[source] = std::move(state);
  }
  return probe;
}

void detachWindowsOsBackgroundMaskSource(IMFMediaSource *source) {
  if (source == nullptr) {
    return;
  }
  std::lock_guard<std::mutex> lock(g_maskSourcesMutex);
  g_maskSources.erase(source);
}

bool extractWindowsOsBackgroundMask(IMFSample *sample,
                                    uint32_t frameWidth,
                                    uint32_t frameHeight,
                                    uint64_t timestampNs,
                                    AlphaMask &out) {
  if (sample == nullptr) {
    return false;
  }
  ComPtr<IMFAttributes> metadata;
  if (FAILED(sample->GetUnknown(MFSampleExtension_CaptureMetadata,
                                IID_PPV_ARGS(&metadata))) ||
      !metadata) {
    return false;
  }

  UINT32 blobSize = 0;
  const size_t headerSize =
      FIELD_OFFSET(KSCAMERA_METADATA_BACKGROUNDSEGMENTATIONMASK, MaskData);
  if (FAILED(metadata->GetBlobSize(
          MF_CAPTURE_METADATA_FRAME_BACKGROUND_MASK, &blobSize)) ||
      blobSize < headerSize) {
    return false;
  }
  std::vector<UINT8> blob(blobSize);
  if (FAILED(metadata->GetBlob(MF_CAPTURE_METADATA_FRAME_BACKGROUND_MASK,
                               blob.data(), blobSize, &blobSize))) {
    return false;
  }

  const auto *ksMask =
      reinterpret_cast<const KSCAMERA_METADATA_BACKGROUNDSEGMENTATIONMASK *>(
          blob.data());
  const uint32_t maskWidth = ksMask->MaskResolution.cx;
  const uint32_t maskHeight = ksMask->MaskResolution.cy;
  const size_t maskPixels = static_cast<size_t>(maskWidth) * maskHeight;
  if (maskWidth == 0u || maskHeight == 0u ||
      blobSize < headerSize + maskPixels) {
    return false;
  }

  OsMaskBlob osBlob;
  osBlob.maskWidth = maskWidth;
  osBlob.maskHeight = maskHeight;
  osBlob.maskCoverageBox = rectFromKs(ksMask->MaskCoverageBoundingBox);
  osBlob.foregroundBox = rectFromKs(ksMask->ForegroundBoundingBox);
  osBlob.alpha.assign(blob.data() + headerSize,
                      blob.data() + headerSize + maskPixels);
  return mapOsBackgroundMaskToAlphaMask(osBlob, frameWidth, frameHeight,
                                        timestampNs, out);
}
#endif

}  // namespace broadify::meeting
