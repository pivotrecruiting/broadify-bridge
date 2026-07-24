#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <unknwn.h>
#include <winrt/base.h>

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mfvirtualcamera.h>

#include <string>

#include "media_source.h"
#include "mf_attributes.h"
#include <initguid.h>  // makes DEFINE_GUID below allocate CLSID_BroadifyVCam.
#include "vcam_guid.h"
#include "vcam_log.h"

using namespace broadify::vcam;

static HMODULE g_module = nullptr;

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}

// IMFActivate object created by MFCreateVirtualCamera; hands out the media
// source when the Frame Server (or a source reader) activates the camera.
struct Activator
    : winrt::implements<Activator, AttributesBase<IMFActivate>> {
  STDMETHODIMP ActivateObject(REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (!_source) {
      _source = winrt::make_self<MediaSource>();
      const HRESULT hr = _source->Initialize(this);
      if (FAILED(hr)) {
        VcamLog("Activator::ActivateObject source init failed 0x%08lx", hr);
        return hr;
      }
    }
    return _source.as(riid, ppv);
  }

  STDMETHODIMP ShutdownObject() { return S_OK; }

  STDMETHODIMP DetachObject() {
    _source = nullptr;
    return S_OK;
  }

  HRESULT Initialize() {
    HRESULT hr =
        SetUINT32(MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1);
    if (FAILED(hr)) return hr;
    return SetGUID(MFT_TRANSFORM_CLSID_Attribute, CLSID_BroadifyVCam);
  }

 private:
  winrt::com_ptr<MediaSource> _source;
};

struct ClassFactory : winrt::implements<ClassFactory, IClassFactory> {
  STDMETHODIMP CreateInstance(IUnknown *outer, REFIID riid,
                              void **result) noexcept final {
    if (!result) return E_POINTER;
    *result = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    auto activator = winrt::make_self<Activator>();
    const HRESULT hr = activator->Initialize();
    if (FAILED(hr)) return hr;
    return activator.as(riid, result);
  }

  STDMETHODIMP LockServer(BOOL) noexcept final { return S_OK; }
};

_Check_return_ STDAPI DllGetClassObject(_In_ REFCLSID rclsid, _In_ REFIID riid,
                                        _Outptr_ LPVOID *ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  if (rclsid == CLSID_BroadifyVCam) {
    return winrt::make_self<ClassFactory>()->QueryInterface(riid, ppv);
  }
  return CLASS_E_CLASSNOTAVAILABLE;
}

__control_entrypoint(DllExport) STDAPI DllCanUnloadNow() {
  return winrt::get_module_lock() ? S_FALSE : S_OK;
}

namespace {

HRESULT regSetString(HKEY root, const wchar_t *subkey, const wchar_t *name,
                     const wchar_t *value) {
  HKEY key = nullptr;
  LONG result = RegCreateKeyExW(root, subkey, 0, nullptr, 0, KEY_WRITE, nullptr,
                                &key, nullptr);
  if (result != ERROR_SUCCESS) return HRESULT_FROM_WIN32(result);
  result = RegSetValueExW(
      key, name, 0, REG_SZ, reinterpret_cast<const BYTE *>(value),
      static_cast<DWORD>((wcslen(value) + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  return HRESULT_FROM_WIN32(result);
}

std::wstring clsidSubKey() {
  wchar_t clsid[64] = {0};
  StringFromGUID2(CLSID_BroadifyVCam, clsid, 64);
  return std::wstring(L"Software\\Classes\\CLSID\\") + clsid;
}

}  // namespace

// Registers the media source under HKLM — the Frame Server can only resolve the
// CLSID from HKEY_LOCAL_MACHINE, so this requires elevation:
//   regsvr32 broadify-vcam.dll          (register, run as Administrator)
//   regsvr32 /u broadify-vcam.dll       (unregister, run as Administrator)
STDAPI DllRegisterServer() {
  wchar_t dllPath[MAX_PATH] = {0};
  if (GetModuleFileNameW(g_module, dllPath, MAX_PATH) == 0) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  const std::wstring key = clsidSubKey() + L"\\InprocServer32";
  HRESULT hr = regSetString(HKEY_LOCAL_MACHINE, key.c_str(), nullptr, dllPath);
  if (FAILED(hr)) return hr;
  return regSetString(HKEY_LOCAL_MACHINE, key.c_str(), L"ThreadingModel",
                      L"Both");
}

// Removes every key written by DllRegisterServer, leaving no residue.
STDAPI DllUnregisterServer() {
  const LONG result =
      RegDeleteTreeW(HKEY_LOCAL_MACHINE, clsidSubKey().c_str());
  if (result != ERROR_SUCCESS && result != ERROR_FILE_NOT_FOUND) {
    return HRESULT_FROM_WIN32(result);
  }
  return S_OK;
}
