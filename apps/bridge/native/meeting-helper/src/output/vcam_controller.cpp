#include "output/vcam_controller.h"

#if defined(_WIN32)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>

#include <cstdio>
#include <mutex>

namespace broadify::meeting {
namespace {

// Must match the CLSID registered for broadify-vcam.dll (see
// native/vcam-helper/windows/vcam_guid.h).
constexpr wchar_t kSourceId[] = L"{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}";

std::mutex g_mutex;
IMFVirtualCamera *g_vcam = nullptr;
bool g_mfStarted = false;
bool g_comReady = false;
std::string g_lastError;

std::string formatHr(const char *what, HRESULT hr) {
  char buf[192];
  snprintf(buf, sizeof(buf), "%s failed 0x%08lx", what, static_cast<unsigned long>(hr));
  return buf;
}

// MFCreateVirtualCamera exists only on Windows 11 (mfsensorgroup.dll on
// Windows 10 / Server lacks the export). A static import would make the
// WHOLE helper fail to load there (STATUS_ENTRYPOINT_NOT_FOUND), killing
// keying/recording too — so resolve it at runtime and degrade to a clear
// "virtual camera unsupported" error instead.
typedef HRESULT(WINAPI *MFCreateVirtualCameraFn)(
    MFVirtualCameraType type, MFVirtualCameraLifetime lifetime,
    MFVirtualCameraAccess access, LPCWSTR friendlyName, LPCWSTR sourceId,
    const GUID *categories, ULONG categoryCount, IMFVirtualCamera **virtualCamera);

MFCreateVirtualCameraFn resolveMFCreateVirtualCamera() {
  static MFCreateVirtualCameraFn fn = []() -> MFCreateVirtualCameraFn {
    HMODULE module = LoadLibraryW(L"mfsensorgroup.dll");
    if (module == nullptr) {
      return nullptr;
    }
    return reinterpret_cast<MFCreateVirtualCameraFn>(
        GetProcAddress(module, "MFCreateVirtualCamera"));
  }();
  return fn;
}

}  // namespace

bool startVirtualCamera(std::string &errorOut) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_vcam) {
    return true;
  }
  if (!g_comReady) {
    const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    g_comReady = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
  }
  if (!g_mfStarted && SUCCEEDED(MFStartup(MF_VERSION))) {
    g_mfStarted = true;
  }

  const MFCreateVirtualCameraFn createVirtualCamera = resolveMFCreateVirtualCamera();
  if (createVirtualCamera == nullptr) {
    g_lastError =
        "Virtual camera requires Windows 11 (MFCreateVirtualCamera is not "
        "available on this Windows version).";
    errorOut = g_lastError;
    return false;
  }

  HRESULT hr = createVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser, L"Broadify Camera", kSourceId, nullptr,
      0, &g_vcam);
  if (FAILED(hr)) {
    g_lastError =
        formatHr("MFCreateVirtualCamera", hr) +
        " (is broadify-vcam.dll registered? regsvr32 requires elevation)";
    errorOut = g_lastError;
    g_vcam = nullptr;
    return false;
  }

  hr = g_vcam->Start(nullptr);
  if (FAILED(hr)) {
    g_lastError = formatHr("IMFVirtualCamera::Start", hr);
    errorOut = g_lastError;
    g_vcam->Remove();
    g_vcam->Release();
    g_vcam = nullptr;
    return false;
  }

  g_lastError.clear();
  return true;
}

void stopVirtualCamera() {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_vcam) {
    g_vcam->Stop();
    g_vcam->Remove();
    g_vcam->Release();
    g_vcam = nullptr;
  }
}

VcamStatus virtualCameraStatus() {
  std::lock_guard<std::mutex> lock(g_mutex);
  return VcamStatus{g_vcam != nullptr, true, g_lastError};
}

}  // namespace broadify::meeting

#else  // non-Windows: the virtual camera is a separate app driven by the bridge.

namespace broadify::meeting {

bool startVirtualCamera(std::string &errorOut) {
  errorOut = "virtual camera is only supported on Windows";
  return false;
}

void stopVirtualCamera() {}

VcamStatus virtualCameraStatus() { return VcamStatus{false, false, ""}; }

}  // namespace broadify::meeting

#endif
