#include "compose/gpu_context_win.h"

#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <iostream>
#include <iterator>

#ifdef _WIN32
#include <d3d11.h>
#include <d3d12.h>
#include <d3d10.h>
#include <dxgi1_6.h>
#include <wrl/wrappers/corewrappers.h>
#endif

namespace broadify::meeting {

bool meetingGpuResidentEnabled() {
  const char *value = std::getenv("BROADIFY_MEETING_GPU_RESIDENT");
  return value != nullptr && std::strcmp(value, "1") == 0;
}

#ifdef _WIN32
namespace {

std::string hrHex(HRESULT hr) {
  char buffer[32];
  snprintf(buffer, sizeof(buffer), "0x%08lX", static_cast<unsigned long>(hr));
  return buffer;
}

void logGpuContextEvent(const char *event, const std::string &detail) {
  std::cout << "{\"type\":\"meeting_gpu_context\",\"event\":\"" << event
            << "\",\"detail\":\"" << detail << "\"}" << std::endl;
}

void fillLuidTelemetry(ID3D11Device *d3d11Device,
                       ID3D12Device *d3d12Device,
                       GpuContextTelemetry &telemetry) {
  Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
  Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
  DXGI_ADAPTER_DESC desc11{};
  if (d3d11Device != nullptr && SUCCEEDED(d3d11Device->QueryInterface(IID_PPV_ARGS(&dxgiDevice))) &&
      SUCCEEDED(dxgiDevice->GetAdapter(&adapter)) &&
      SUCCEEDED(adapter->GetDesc(&desc11))) {
    telemetry.d3d11LuidHigh = desc11.AdapterLuid.HighPart;
    telemetry.d3d11LuidLow =
        static_cast<uint64_t>(static_cast<uint32_t>(desc11.AdapterLuid.LowPart));
  }
  if (d3d12Device != nullptr) {
    const LUID luid12 = d3d12Device->GetAdapterLuid();
    telemetry.d3d12LuidHigh = luid12.HighPart;
    telemetry.d3d12LuidLow =
        static_cast<uint64_t>(static_cast<uint32_t>(luid12.LowPart));
  }
}

}  // namespace

GpuContextWin &GpuContextWin::shared() {
  static GpuContextWin context;
  return context;
}

bool GpuContextWin::available() {
  std::call_once(initializeOnce_, [this]() {
    available_ = initialize();
  });
  return available_;
}

bool GpuContextWin::initialize() {
  telemetry_.gpuResident = meetingGpuResidentEnabled();
  if (!telemetry_.gpuResident) {
    failureReason_ = "gpu_resident_disabled";
    return false;
  }

  const D3DAdapterInfo &selected = sharedD3DAdapter();
  HRESULT hr = E_FAIL;
  const char *selfTestDriver = std::getenv("BROADIFY_MEETING_GPU_SELF_TEST_DRIVER");
  if (selfTestDriver != nullptr && std::strcmp(selfTestDriver, "warp") == 0) {
    Microsoft::WRL::ComPtr<IDXGIFactory4> factory;
    Microsoft::WRL::ComPtr<IDXGIAdapter> warpAdapter;
    hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (SUCCEEDED(hr)) {
      hr = factory->EnumWarpAdapter(IID_PPV_ARGS(&warpAdapter));
    }
    if (SUCCEEDED(hr)) {
      hr = warpAdapter.As(&adapter_);
      telemetry_.adapter = "WARP";
    }
  } else {
    if (!selected.available || !selected.adapter) {
      failureReason_ = "adapter_unavailable";
      logGpuContextEvent("unavailable", failureReason_);
      return false;
    }
    telemetry_.adapter = d3dAdapterStatusString(selected);
    hr = selected.adapter.As(&adapter_);
  }
  if (FAILED(hr)) {
    failureReason_ = "adapter4_unavailable " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }

  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1,
                                      D3D_FEATURE_LEVEL_11_0};
  Microsoft::WRL::ComPtr<ID3D11Device> baseDevice;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> baseContext;
  D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;
  hr = D3D11CreateDevice(adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                         D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels,
                         static_cast<UINT>(std::size(levels)),
                         D3D11_SDK_VERSION, &baseDevice, &got, &baseContext);
  if (FAILED(hr) || got < D3D_FEATURE_LEVEL_11_0) {
    failureReason_ = "d3d11_create_failed " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }
  hr = baseDevice.As(&d3d11Device_);
  if (FAILED(hr) || !d3d11Device_) {
    failureReason_ = "d3d11_device5_unavailable " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }
  Microsoft::WRL::ComPtr<ID3D10Multithread> multithread;
  hr = d3d11Device_.As(&multithread);
  if (FAILED(hr) || multithread == nullptr) {
    failureReason_ = "d3d11_multithread_protection_failed " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }
  multithread->SetMultithreadProtected(TRUE);
  hr = baseContext.As(&d3d11Context_);
  if (FAILED(hr) || !d3d11Context_) {
    failureReason_ = "d3d11_context4_unavailable " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }

  hr = D3D12CreateDevice(adapter_.Get(), D3D_FEATURE_LEVEL_11_0,
                         IID_PPV_ARGS(&d3d12Device_));
  if (FAILED(hr)) {
    failureReason_ = "d3d12_create_failed " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }
  D3D12_COMMAND_QUEUE_DESC queueDesc{};
  queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  queueDesc.Priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
  hr = d3d12Device_->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&d3d12Queue_));
  if (FAILED(hr)) {
    failureReason_ = "d3d12_queue_failed " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }
  hr = d3d12Device_->CreateFence(0, D3D12_FENCE_FLAG_SHARED,
                                 IID_PPV_ARGS(&d3d12Fence_));
  if (FAILED(hr)) {
    failureReason_ = "shared_fence_failed " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }
  HANDLE rawFenceHandle = nullptr;
  hr = d3d12Device_->CreateSharedHandle(d3d12Fence_.Get(), nullptr,
                                        GENERIC_ALL, nullptr, &rawFenceHandle);
  if (FAILED(hr)) {
    failureReason_ = "shared_fence_handle_failed " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }
  sharedFenceHandle_.Attach(rawFenceHandle);
  hr = d3d11Device_->OpenSharedFence(sharedFenceHandle_.Get(),
                                     IID_PPV_ARGS(&d3d11Fence_));
  if (FAILED(hr)) {
    failureReason_ = "d3d11_open_shared_fence_failed " + hrHex(hr);
    logGpuContextEvent("unavailable", failureReason_);
    return false;
  }

  telemetry_.available = true;
  fillLuidTelemetry(d3d11Device_.Get(), d3d12Device_.Get(), telemetry_);
  logGpuContextEvent("enabled", telemetry_.adapter);
  return true;
}

bool GpuContextWin::signalFromD3D11(uint64_t value) {
  if (!available()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(immediateContextMutex_);
  return SUCCEEDED(d3d11Context_->Signal(d3d11Fence_.Get(), value));
}

bool GpuContextWin::waitOnD3D12(uint64_t value) {
  return available() && SUCCEEDED(d3d12Queue_->Wait(d3d12Fence_.Get(), value));
}

bool GpuContextWin::signalFromD3D12(uint64_t value) {
  return available() && SUCCEEDED(d3d12Queue_->Signal(d3d12Fence_.Get(), value));
}

bool GpuContextWin::waitOnD3D11(uint64_t value) {
  if (!available()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(immediateContextMutex_);
  return SUCCEEDED(d3d11Context_->Wait(d3d11Fence_.Get(), value));
}
#endif

GpuContextTelemetry currentGpuContextTelemetry() {
#ifdef _WIN32
  GpuContextWin &context = GpuContextWin::shared();
  context.available();
  return context.telemetry();
#else
  return GpuContextTelemetry{};
#endif
}

}  // namespace broadify::meeting
