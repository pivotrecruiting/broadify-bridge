#include "keyer/dml_device_input.h"

#if BROADIFY_ENABLE_MODNET && defined(_WIN32)

#include <d3dcompiler.h>

#include <algorithm>
#include <array>
#include <cstring>

namespace broadify::meeting {
namespace {

using Microsoft::WRL::ComPtr;

// Compute port of buildModnetInputTensor (matting_common.cpp). Parity is
// load-bearing: the integer block bounds, the clamps, the uint sums and the
// (x-0.5)/0.5 normalization mirror writeIntegerBlockAverage exactly, so the
// zerocopy_parity gate in modnet_keyer can diff the two tensors elementwise.
// Letterbox padding writes 0.0 = normalized mid-gray, same as the CPU fill.
// dstTensor is a typed UAV (R32_FLOAT or R16_FLOAT for the fp16 model); the
// store conversion happens in hardware.
constexpr char kBuildInputShader[] = R"HLSL(
cbuffer Params : register(b0) {
  uint srcWidth;
  uint srcHeight;
  uint inputSize;
  uint contentX;
  uint contentY;
  uint contentWidth;
  uint contentHeight;
};

ByteAddressBuffer srcRgba : register(t0);
RWBuffer<float> dstTensor : register(u0);

[numthreads(8, 8, 1)]
void buildInput(uint3 tid : SV_DispatchThreadID) {
  if (tid.x >= inputSize || tid.y >= inputSize) {
    return;
  }
  const uint channelSize = inputSize * inputSize;
  const uint dstOffset = tid.y * inputSize + tid.x;
  float r = 0.0f;
  float g = 0.0f;
  float b = 0.0f;
  const bool inside =
      contentWidth != 0u && contentHeight != 0u && srcWidth != 0u &&
      srcHeight != 0u && tid.x >= contentX && tid.x < contentX + contentWidth &&
      tid.y >= contentY && tid.y < contentY + contentHeight;
  if (inside) {
    const uint cx = tid.x - contentX;
    const uint cy = tid.y - contentY;
    uint left = (cx * srcWidth) / contentWidth;
    uint top = (cy * srcHeight) / contentHeight;
    uint right = ((cx + 1u) * srcWidth) / contentWidth;
    uint bottom = ((cy + 1u) * srcHeight) / contentHeight;
    left = min(left, srcWidth - 1u);
    top = min(top, srcHeight - 1u);
    right = min(max(right, left + 1u), srcWidth);
    bottom = min(max(bottom, top + 1u), srcHeight);
    uint sumR = 0u;
    uint sumG = 0u;
    uint sumB = 0u;
    for (uint y = top; y < bottom; ++y) {
      uint addr = (y * srcWidth + left) * 4u;
      for (uint x = left; x < right; ++x) {
        const uint px = srcRgba.Load(addr);
        sumR += px & 0xffu;
        sumG += (px >> 8u) & 0xffu;
        sumB += (px >> 16u) & 0xffu;
        addr += 4u;
      }
    }
    const uint count = (right - left) * (bottom - top);
    const float scale = 1.0f / (float(count) * 255.0f);
    r = (float(sumR) * scale - 0.5f) / 0.5f;
    g = (float(sumG) * scale - 0.5f) / 0.5f;
    b = (float(sumB) * scale - 0.5f) / 0.5f;
  }
  dstTensor[dstOffset] = r;
  dstTensor[channelSize + dstOffset] = g;
  dstTensor[channelSize * 2u + dstOffset] = b;
}
)HLSL";

constexpr uint32_t kThreadGroupSize = 8u;

float halfBitsToFloat(uint16_t bits) {
  const uint32_t sign = static_cast<uint32_t>(bits >> 15) & 0x1u;
  const uint32_t exponent = static_cast<uint32_t>(bits >> 10) & 0x1fu;
  const uint32_t mantissa = static_cast<uint32_t>(bits) & 0x3ffu;
  uint32_t f32;
  if (exponent == 0u) {
    if (mantissa == 0u) {
      f32 = sign << 31;
    } else {
      // Subnormal half: renormalize into the f32 exponent range.
      uint32_t e = 0u;
      uint32_t m = mantissa;
      while ((m & 0x400u) == 0u) {
        m <<= 1;
        ++e;
      }
      f32 = (sign << 31) | ((112u - e) << 23) | ((m & 0x3ffu) << 13);
    }
  } else if (exponent == 0x1fu) {
    f32 = (sign << 31) | 0x7f800000u | (mantissa << 13);
  } else {
    f32 = (sign << 31) | ((exponent + 112u) << 23) | (mantissa << 13);
  }
  float result;
  std::memcpy(&result, &f32, sizeof(result));
  return result;
}

bool createBuffer(ID3D12Device *device, D3D12_HEAP_TYPE heapType, size_t bytes,
                  D3D12_RESOURCE_FLAGS flags, D3D12_RESOURCE_STATES state,
                  ComPtr<ID3D12Resource> *out) {
  D3D12_HEAP_PROPERTIES heap{};
  heap.Type = heapType;
  D3D12_RESOURCE_DESC desc{};
  desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  desc.Width = bytes;
  desc.Height = 1;
  desc.DepthOrArraySize = 1;
  desc.MipLevels = 1;
  desc.Format = DXGI_FORMAT_UNKNOWN;
  desc.SampleDesc.Count = 1;
  desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  desc.Flags = flags;
  return SUCCEEDED(device->CreateCommittedResource(
      &heap, D3D12_HEAP_FLAG_NONE, &desc, state, nullptr, IID_PPV_ARGS(&*out)));
}

}  // namespace

std::unique_ptr<DmlDeviceInputStage> DmlDeviceInputStage::create(
    ID3D12Device *device, ID3D12CommandQueue *queue, const OrtDmlApi *dmlApi,
    uint32_t inputSize, bool fp16, std::string *errorOut) {
  auto fail = [errorOut](const char *reason) -> std::unique_ptr<DmlDeviceInputStage> {
    if (errorOut != nullptr) {
      *errorOut = reason;
    }
    return nullptr;
  };
  if (device == nullptr || queue == nullptr || dmlApi == nullptr ||
      inputSize == 0u || inputSize % kThreadGroupSize != 0u) {
    return fail("invalid_arguments");
  }

  const DXGI_FORMAT tensorFormat =
      fp16 ? DXGI_FORMAT_R16_FLOAT : DXGI_FORMAT_R32_FLOAT;
  D3D12_FEATURE_DATA_FORMAT_SUPPORT formatSupport{tensorFormat};
  if (FAILED(device->CheckFeatureSupport(D3D12_FEATURE_FORMAT_SUPPORT,
                                         &formatSupport,
                                         sizeof(formatSupport))) ||
      (formatSupport.Support2 & D3D12_FORMAT_SUPPORT2_UAV_TYPED_STORE) == 0u) {
    return fail("uav_typed_store_unsupported");
  }

  std::unique_ptr<DmlDeviceInputStage> stage(new DmlDeviceInputStage());
  stage->device_ = device;
  stage->queue_ = queue;
  stage->dmlApi_ = dmlApi;
  stage->inputSize_ = inputSize;
  stage->fp16_ = fp16;

  ComPtr<ID3DBlob> shader;
  ComPtr<ID3DBlob> errors;
  if (FAILED(D3DCompile(kBuildInputShader, std::strlen(kBuildInputShader),
                        "modnet_build_input", nullptr, nullptr, "buildInput",
                        "cs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &shader,
                        &errors))) {
    return fail("shader_compile_failed");
  }

  D3D12_ROOT_PARAMETER params[3]{};
  params[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
  params[0].Constants.ShaderRegister = 0;
  params[0].Constants.Num32BitValues = 7;
  params[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
  params[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_SRV;
  params[1].Descriptor.ShaderRegister = 0;
  params[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
  D3D12_DESCRIPTOR_RANGE uavRange{};
  uavRange.RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_UAV;
  uavRange.NumDescriptors = 1;
  uavRange.BaseShaderRegister = 0;
  params[2].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
  params[2].DescriptorTable.NumDescriptorRanges = 1;
  params[2].DescriptorTable.pDescriptorRanges = &uavRange;
  params[2].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
  D3D12_ROOT_SIGNATURE_DESC rootDesc{};
  rootDesc.NumParameters = 3;
  rootDesc.pParameters = params;
  ComPtr<ID3DBlob> rootBlob;
  if (FAILED(D3D12SerializeRootSignature(&rootDesc, D3D_ROOT_SIGNATURE_VERSION_1,
                                         &rootBlob, nullptr)) ||
      FAILED(device->CreateRootSignature(
          0, rootBlob->GetBufferPointer(), rootBlob->GetBufferSize(),
          IID_PPV_ARGS(&stage->rootSignature_)))) {
    return fail("root_signature_failed");
  }

  D3D12_COMPUTE_PIPELINE_STATE_DESC psoDesc{};
  psoDesc.pRootSignature = stage->rootSignature_.Get();
  psoDesc.CS.pShaderBytecode = shader->GetBufferPointer();
  psoDesc.CS.BytecodeLength = shader->GetBufferSize();
  if (FAILED(device->CreateComputePipelineState(&psoDesc,
                                                IID_PPV_ARGS(&stage->pso_)))) {
    return fail("pso_failed");
  }

  // The command list type must match the queue ORT executes the session on
  // (compute by default, direct via BROADIFY_MEETING_DML_QUEUE).
  const D3D12_COMMAND_LIST_TYPE listType = queue->GetDesc().Type;
  if (FAILED(device->CreateCommandAllocator(
          listType, IID_PPV_ARGS(&stage->cmdAlloc_))) ||
      FAILED(device->CreateCommandList(0, listType, stage->cmdAlloc_.Get(),
                                       nullptr,
                                       IID_PPV_ARGS(&stage->cmdList_))) ||
      FAILED(stage->cmdList_->Close())) {
    return fail("command_list_failed");
  }

  const size_t elementCount = static_cast<size_t>(3u) * inputSize * inputSize;
  const size_t elementBytes = fp16 ? 2u : 4u;
  const size_t tensorBytes = elementCount * elementBytes;
  // The DML EP requires wrapped resources to live in the UAV state; the
  // buffer stays there for its whole life (the parity readback transitions
  // out and back once).
  if (!createBuffer(device, D3D12_HEAP_TYPE_DEFAULT, tensorBytes,
                    D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS,
                    D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                    &stage->tensorBuffer_)) {
    return fail("tensor_buffer_failed");
  }

  D3D12_DESCRIPTOR_HEAP_DESC heapDesc{};
  heapDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
  heapDesc.NumDescriptors = 1;
  heapDesc.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
  if (FAILED(device->CreateDescriptorHeap(&heapDesc,
                                          IID_PPV_ARGS(&stage->uavHeap_)))) {
    return fail("descriptor_heap_failed");
  }
  D3D12_UNORDERED_ACCESS_VIEW_DESC uavDesc{};
  uavDesc.Format = tensorFormat;
  uavDesc.ViewDimension = D3D12_UAV_DIMENSION_BUFFER;
  uavDesc.Buffer.NumElements = static_cast<UINT>(elementCount);
  device->CreateUnorderedAccessView(
      stage->tensorBuffer_.Get(), nullptr, &uavDesc,
      stage->uavHeap_->GetCPUDescriptorHandleForHeapStart());

  if (FAILED(device->CreateFence(0, D3D12_FENCE_FLAG_NONE,
                                 IID_PPV_ARGS(&stage->fence_)))) {
    return fail("fence_failed");
  }
  stage->fenceEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (stage->fenceEvent_ == nullptr) {
    return fail("fence_event_failed");
  }

  if (dmlApi->CreateGPUAllocationFromD3DResource(
          stage->tensorBuffer_.Get(), &stage->dmlAllocation_) != nullptr) {
    stage->dmlAllocation_ = nullptr;
    return fail("dml_allocation_failed");
  }
  try {
    const Ort::MemoryInfo memoryInfo("DML", OrtDeviceAllocator, 0,
                                     OrtMemTypeDefault);
    const std::array<int64_t, 4> shape = {1, 3,
                                          static_cast<int64_t>(inputSize),
                                          static_cast<int64_t>(inputSize)};
    stage->ortValue_ = Ort::Value::CreateTensor(
        memoryInfo, stage->dmlAllocation_, tensorBytes, shape.data(),
        shape.size(),
        fp16 ? ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16
             : ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT);
  } catch (...) {
    return fail("ort_value_failed");
  }
  return stage;
}

DmlDeviceInputStage::~DmlDeviceInputStage() {
  // Best effort: never destroy resources the GPU may still read.
  waitForGpu();
  if (dmlAllocation_ != nullptr && dmlApi_ != nullptr) {
    OrtStatus *status = dmlApi_->FreeGPUAllocation(dmlAllocation_);
    if (status != nullptr) {
      Ort::GetApi().ReleaseStatus(status);
    }
  }
  if (uploadMapped_ != nullptr && uploadBuffer_) {
    uploadBuffer_->Unmap(0, nullptr);
  }
  if (fenceEvent_ != nullptr) {
    CloseHandle(fenceEvent_);
  }
}

bool DmlDeviceInputStage::ensureUploadCapacity(size_t bytes) {
  if (uploadBuffer_ && uploadCapacity_ >= bytes) {
    return true;
  }
  if (uploadMapped_ != nullptr && uploadBuffer_) {
    uploadBuffer_->Unmap(0, nullptr);
    uploadMapped_ = nullptr;
  }
  uploadBuffer_.Reset();
  uploadCapacity_ = 0;
  if (!createBuffer(device_.Get(), D3D12_HEAP_TYPE_UPLOAD, bytes,
                    D3D12_RESOURCE_FLAG_NONE, D3D12_RESOURCE_STATE_GENERIC_READ,
                    &uploadBuffer_)) {
    return false;
  }
  void *mapped = nullptr;
  const D3D12_RANGE noRead{0, 0};
  if (FAILED(uploadBuffer_->Map(0, &noRead, &mapped))) {
    uploadBuffer_.Reset();
    return false;
  }
  uploadMapped_ = static_cast<uint8_t *>(mapped);
  uploadCapacity_ = bytes;
  return true;
}

bool DmlDeviceInputStage::waitForGpu() {
  if (!fence_ || fence_->GetCompletedValue() >= fenceValue_) {
    return true;
  }
  if (FAILED(fence_->SetEventOnCompletion(fenceValue_, fenceEvent_))) {
    return false;
  }
  return WaitForSingleObject(fenceEvent_, 5000) == WAIT_OBJECT_0;
}

bool DmlDeviceInputStage::buildDeviceTensor(
    const VideoFrame &frame, const ModnetLetterboxMapping &mapping) {
  const size_t frameBytes =
      static_cast<size_t>(frame.width) * frame.height * 4u;
  if (frame.width == 0u || frame.height == 0u ||
      frame.rgba.size() < frameBytes ||
      mapping.inputWidth != inputSize_ || mapping.inputHeight != inputSize_) {
    return false;
  }
  // The previous submission is normally long drained (Run's CPU readback
  // syncs the queue); the wait only matters when a Run failed mid-frame.
  if (!waitForGpu()) {
    return false;
  }
  if (!ensureUploadCapacity(frameBytes)) {
    return false;
  }
  std::memcpy(uploadMapped_, frame.rgba.data(), frameBytes);

  if (FAILED(cmdAlloc_->Reset()) ||
      FAILED(cmdList_->Reset(cmdAlloc_.Get(), pso_.Get()))) {
    return false;
  }
  cmdList_->SetComputeRootSignature(rootSignature_.Get());
  ID3D12DescriptorHeap *heaps[] = {uavHeap_.Get()};
  cmdList_->SetDescriptorHeaps(1, heaps);
  const uint32_t constants[7] = {frame.width,        frame.height,
                                 inputSize_,         mapping.contentX,
                                 mapping.contentY,   mapping.contentWidth,
                                 mapping.contentHeight};
  cmdList_->SetComputeRoot32BitConstants(0, 7, constants, 0);
  cmdList_->SetComputeRootShaderResourceView(
      1, uploadBuffer_->GetGPUVirtualAddress());
  cmdList_->SetComputeRootDescriptorTable(
      2, uavHeap_->GetGPUDescriptorHandleForHeapStart());
  cmdList_->Dispatch(inputSize_ / kThreadGroupSize,
                     inputSize_ / kThreadGroupSize, 1);
  // Make the tensor writes visible to the DML dispatches ORT submits next on
  // this same queue.
  D3D12_RESOURCE_BARRIER uavBarrier{};
  uavBarrier.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
  uavBarrier.UAV.pResource = tensorBuffer_.Get();
  cmdList_->ResourceBarrier(1, &uavBarrier);
  if (FAILED(cmdList_->Close())) {
    return false;
  }
  ID3D12CommandList *lists[] = {cmdList_.Get()};
  queue_->ExecuteCommandLists(1, lists);
  return SUCCEEDED(queue_->Signal(fence_.Get(), ++fenceValue_));
}

bool DmlDeviceInputStage::readbackTensorFp32(std::vector<float> &out) {
  const size_t elementCount =
      static_cast<size_t>(3u) * inputSize_ * inputSize_;
  const size_t elementBytes = fp16_ ? 2u : 4u;
  const size_t tensorBytes = elementCount * elementBytes;
  if (!waitForGpu()) {
    return false;
  }
  if (!readbackBuffer_ &&
      !createBuffer(device_.Get(), D3D12_HEAP_TYPE_READBACK, tensorBytes,
                    D3D12_RESOURCE_FLAG_NONE, D3D12_RESOURCE_STATE_COPY_DEST,
                    &readbackBuffer_)) {
    return false;
  }
  if (FAILED(cmdAlloc_->Reset()) ||
      FAILED(cmdList_->Reset(cmdAlloc_.Get(), nullptr))) {
    return false;
  }
  D3D12_RESOURCE_BARRIER toCopy{};
  toCopy.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  toCopy.Transition.pResource = tensorBuffer_.Get();
  toCopy.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
  toCopy.Transition.StateBefore = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
  toCopy.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
  cmdList_->ResourceBarrier(1, &toCopy);
  cmdList_->CopyResource(readbackBuffer_.Get(), tensorBuffer_.Get());
  D3D12_RESOURCE_BARRIER toUav = toCopy;
  toUav.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
  toUav.Transition.StateAfter = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
  cmdList_->ResourceBarrier(1, &toUav);
  if (FAILED(cmdList_->Close())) {
    return false;
  }
  ID3D12CommandList *lists[] = {cmdList_.Get()};
  queue_->ExecuteCommandLists(1, lists);
  if (FAILED(queue_->Signal(fence_.Get(), ++fenceValue_)) || !waitForGpu()) {
    return false;
  }
  void *mapped = nullptr;
  const D3D12_RANGE readRange{0, tensorBytes};
  if (FAILED(readbackBuffer_->Map(0, &readRange, &mapped))) {
    return false;
  }
  out.resize(elementCount);
  if (fp16_) {
    const uint16_t *halves = static_cast<const uint16_t *>(mapped);
    for (size_t i = 0; i < elementCount; ++i) {
      out[i] = halfBitsToFloat(halves[i]);
    }
  } else {
    std::memcpy(out.data(), mapped, tensorBytes);
  }
  const D3D12_RANGE noWrite{0, 0};
  readbackBuffer_->Unmap(0, &noWrite);
  return true;
}

}  // namespace broadify::meeting

#endif  // BROADIFY_ENABLE_MODNET && _WIN32
