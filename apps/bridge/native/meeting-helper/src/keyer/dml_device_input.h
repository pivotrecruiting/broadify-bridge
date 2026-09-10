#pragma once

// GPU-resident MODNet input build for the Windows/DirectML keyer (opt-in via
// BROADIFY_MEETING_KEYER_ZEROCOPY, default off). One stage per prebuilt tier
// session: a D3D12 compute shader replicates buildModnetInputTensor
// (letterbox + integer block-average + (x-0.5)/0.5 normalization, NCHW) from
// the uploaded RGBA frame straight into a default-heap buffer that is bound
// as a DML device input through ORT IoBinding - removing the per-frame CPU
// tensor build and ORT's internal CPU->GPU input copy. Output readback stays
// on the CPU. Only usable on the dml1_selected_adapter path, where the keyer
// owns the D3D12 device and the command queue the DML EP executes on:
// submitting the preprocessing on that same queue orders it before the
// session Run without cross-queue fences.

#if BROADIFY_ENABLE_MODNET && defined(_WIN32)

#include "keyer/keyer.h"
#include "keyer/matting_common.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <d3d12.h>
#include <wrl/client.h>

#include <onnxruntime_cxx_api.h>
#include <dml_provider_factory.h>

namespace broadify::meeting {

class DmlDeviceInputStage {
 public:
  // Creates all D3D12 resources (upload buffer grows with the camera frame,
  // tensor buffer sized 3*inputSize^2 elements, PSO, fence) and wraps the
  // tensor buffer as a DML allocation. Returns nullptr on any failure and
  // stores a short reason in errorOut; callers then stay on the CPU path.
  static std::unique_ptr<DmlDeviceInputStage> create(
      ID3D12Device *device, ID3D12CommandQueue *queue, const OrtDmlApi *dmlApi,
      uint32_t inputSize, bool fp16, std::string *errorOut);

  ~DmlDeviceInputStage();

  DmlDeviceInputStage(const DmlDeviceInputStage &) = delete;
  DmlDeviceInputStage &operator=(const DmlDeviceInputStage &) = delete;

  // Uploads the frame, records + submits the tensor-build dispatch on the DML
  // queue and signals the fence. Does NOT wait: the session Run submitted
  // right after on the same queue is ordered behind it, and Run's CPU output
  // readback drains the queue before the next apply reuses the buffers.
  // Returns false on any failure (caller falls back to the CPU tensor path).
  bool buildDeviceTensor(const VideoFrame &frame,
                         const ModnetLetterboxMapping &mapping);

  // The device tensor to BindInput; valid after a successful
  // buildDeviceTensor until the next one.
  const Ort::Value &deviceTensor() const { return ortValue_; }

  // Parity support: blocks until the last submitted build finished, copies
  // the tensor buffer back to the CPU and returns it as fp32 (fp16 buffers
  // are widened). Slow by design - used once per stage for the parity gate.
  bool readbackTensorFp32(std::vector<float> &out);

  bool parityValidated() const { return parityValidated_; }
  void setParityValidated() { parityValidated_ = true; }

 private:
  DmlDeviceInputStage() = default;

  bool ensureUploadCapacity(size_t bytes);
  bool waitForGpu();

  Microsoft::WRL::ComPtr<ID3D12Device> device_;
  Microsoft::WRL::ComPtr<ID3D12CommandQueue> queue_;
  Microsoft::WRL::ComPtr<ID3D12CommandAllocator> cmdAlloc_;
  Microsoft::WRL::ComPtr<ID3D12GraphicsCommandList> cmdList_;
  Microsoft::WRL::ComPtr<ID3D12RootSignature> rootSignature_;
  Microsoft::WRL::ComPtr<ID3D12PipelineState> pso_;
  Microsoft::WRL::ComPtr<ID3D12DescriptorHeap> uavHeap_;
  Microsoft::WRL::ComPtr<ID3D12Resource> uploadBuffer_;
  Microsoft::WRL::ComPtr<ID3D12Resource> tensorBuffer_;
  Microsoft::WRL::ComPtr<ID3D12Resource> readbackBuffer_;
  Microsoft::WRL::ComPtr<ID3D12Fence> fence_;
  HANDLE fenceEvent_ = nullptr;
  uint64_t fenceValue_ = 0;
  uint8_t *uploadMapped_ = nullptr;
  size_t uploadCapacity_ = 0;
  const OrtDmlApi *dmlApi_ = nullptr;
  void *dmlAllocation_ = nullptr;
  Ort::Value ortValue_{nullptr};
  uint32_t inputSize_ = 0;
  bool fp16_ = false;
  bool parityValidated_ = false;
};

}  // namespace broadify::meeting

#endif  // BROADIFY_ENABLE_MODNET && _WIN32
