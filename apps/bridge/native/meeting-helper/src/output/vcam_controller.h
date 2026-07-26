#pragma once

#include <string>

namespace broadify::meeting {

// Lifecycle of the Windows "Broadify Camera" virtual camera
// (MFCreateVirtualCamera, Session lifetime, held by the meeting-helper).
//
// Windows-only. On other platforms these are no-ops and report "unsupported",
// so the cross-platform control server can call them without guards (the macOS
// virtual camera is a separate app driven from the bridge, not this helper).
struct VcamStatus {
  bool active = false;
  bool supported = false;
  std::string lastError;
};

// Creates and starts the virtual camera. Idempotent. Returns false and fills
// errorOut on failure (e.g. the media-source DLL is not registered).
bool startVirtualCamera(std::string &errorOut);

// Stops and removes the virtual camera. Safe to call when not active.
void stopVirtualCamera();

VcamStatus virtualCameraStatus();

}  // namespace broadify::meeting
