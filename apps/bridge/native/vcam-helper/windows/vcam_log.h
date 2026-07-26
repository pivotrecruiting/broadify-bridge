#pragma once

// Fault-tolerant logging for the Windows virtual-camera media source.
//
// The media source runs inside the Windows Frame Server (a service context),
// so logs go to a service-writable location (%ProgramData%\Broadify\vcam.log),
// never the user profile. Logging is best-effort: any failure is swallowed so a
// logging problem can never crash the source — a crash there takes the camera
// down for every app on the system.
namespace broadify::vcam {

void VcamLog(const char *format, ...);

}  // namespace broadify::vcam
