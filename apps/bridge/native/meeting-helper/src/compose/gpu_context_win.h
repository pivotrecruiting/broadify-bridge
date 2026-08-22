#pragma once

#include "compose/d3d_adapter_select.h"
#include "compose/gpu_frame_ring.h"

#include <cstdint>
#include <mutex>
#include <string>

#ifdef _WIN32
#include <d3d11_4.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <wrl/wrappers/corewrappers.h>
#endif

namespace broadify::meeting {

bool meetingGpuResidentEnabled();

struct GpuContextTelemetry {
  bool gpuResident = false;
  bool available = false;
  std::string adapter;
  int64_t d3d11LuidHigh = 0;
  uint64_t d3d11LuidLow = 0;
  int64_t d3d12LuidHigh = 0;
  uint64_t d3d12LuidLow = 0;
};

#ifdef _WIN32
class GpuContextWin {
 public:
  static GpuContextWin &shared();

  bool available();
  const std::string &failureReason() const { return failureReason_; }
  const GpuContextTelemetry &telemetry() const { return telemetry_; }

  IDXGIAdapter4 *adapter() const { return adapter_.Get(); }
  ID3D11Device5 *d3d11Device() const { return d3d11Device_.Get(); }
  ID3D11DeviceContext4 *d3d11Context() const { return d3d11Context_.Get(); }
  ID3D12Device *d3d12Device() const { return d3d12Device_.Get(); }
  ID3D12CommandQueue *d3d12Queue() const { return d3d12Queue_.Get(); }
  ID3D12Fence *d3d12Fence() const { return d3d12Fence_.Get(); }
  ID3D11Fence *d3d11Fence() const { return d3d11Fence_.Get(); }
  GpuFrameRing &frameRing() { return frameRing_; }
  std::mutex &immediateContextMutex() { return immediateContextMutex_; }

  bool signalFromD3D11(uint64_t value);
  bool waitOnD3D12(uint64_t value);
  bool signalFromD3D12(uint64_t value);
  bool waitOnD3D11(uint64_t value);

 private:
  bool initialize();
  bool initialized_ = false;
  bool available_ = false;
  std::string failureReason_;
  GpuContextTelemetry telemetry_;
  GpuFrameRing frameRing_{3};
  std::mutex immediateContextMutex_;
  Microsoft::WRL::ComPtr<IDXGIAdapter4> adapter_;
  Microsoft::WRL::ComPtr<ID3D11Device5> d3d11Device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext4> d3d11Context_;
  Microsoft::WRL::ComPtr<ID3D12Device> d3d12Device_;
  Microsoft::WRL::ComPtr<ID3D12CommandQueue> d3d12Queue_;
  Microsoft::WRL::ComPtr<ID3D12Fence> d3d12Fence_;
  Microsoft::WRL::ComPtr<ID3D11Fence> d3d11Fence_;
  Microsoft::WRL::Wrappers::FileHandle sharedFenceHandle_;
};
#endif

GpuContextTelemetry currentGpuContextTelemetry();

}  // namespace broadify::meeting
