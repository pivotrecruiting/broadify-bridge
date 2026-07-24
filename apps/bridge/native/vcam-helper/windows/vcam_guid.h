#pragma once

#include <guiddef.h>

// CLSID of the Broadify virtual-camera media source. This must match the value
// registered under HKLM\Software\Classes\CLSID\{...}\InprocServer32 and the
// sourceId ("{CLSID}") passed to MFCreateVirtualCamera.
//
// {8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}
DEFINE_GUID(CLSID_BroadifyVCam, 0x8b1e9e3a, 0x7c4d, 0x4e2b, 0x9f, 0x1a, 0x2d,
            0x6c, 0x5b, 0x0a, 0x9e, 0x77);
