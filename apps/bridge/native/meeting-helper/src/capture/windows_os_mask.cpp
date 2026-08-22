#include "capture/windows_os_mask.h"

#if defined(_WIN32)
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <ks.h>
#include <ksmedia.h>
#endif

namespace broadify::meeting {

WindowsOsMaskProbeResult probeWindowsOsBackgroundMask() {
#if defined(_WIN32)
  // The concrete MediaFoundation source object is owned by
  // camera_mediafoundation.cpp. This hook deliberately stays narrow and
  // reviewable: it is the only place that pulls in ks/mf headers for the
  // background-segmentation capability. The current implementation is a safe
  // default until the capture source can pass its IMFMediaSource/IKsControl
  // into this probe without changing macOS.
  WindowsOsMaskProbeResult result;
  result.reason = "capture_source_not_attached";
  return result;
#else
  return WindowsOsMaskProbeResult{};
#endif
}

void configureWindowsOsBackgroundSegmentation(bool enableMask) {
  (void)enableMask;
#if defined(_WIN32)
  // TODO(windows): call IMFExtendedCameraController ->
  // IMFExtendedCameraControl for
  // KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION and set MASK or
  // OFF. Kept separate so the platform-neutral tier policy is covered on
  // macOS and MSVC only needs to compile this guarded unit.
#endif
}

}  // namespace broadify::meeting
