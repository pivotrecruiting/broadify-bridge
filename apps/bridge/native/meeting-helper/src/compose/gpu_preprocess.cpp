#include "compose/gpu_preprocess.h"

#include <algorithm>
#include <cstring>

#ifdef _WIN32
#include <d3dcompiler.h>
#include <iostream>
#endif

namespace broadify::meeting {

std::vector<TensorSampleMapping> buildGpuPreprocessMapping(
    uint32_t sourceWidth,
    uint32_t sourceHeight,
    const ModnetLetterboxMapping &letterbox) {
  std::vector<TensorSampleMapping> mapping;
  if (sourceWidth == 0u || sourceHeight == 0u || letterbox.inputWidth == 0u ||
      letterbox.inputHeight == 0u || letterbox.contentWidth == 0u ||
      letterbox.contentHeight == 0u) {
    return mapping;
  }
  const size_t planeSize =
      static_cast<size_t>(letterbox.inputWidth) * letterbox.inputHeight;
  mapping.reserve(static_cast<size_t>(letterbox.contentWidth) *
                  letterbox.contentHeight * 3u);
  for (uint32_t y = 0; y < letterbox.contentHeight; ++y) {
    const double srcTop =
        static_cast<double>(y) * static_cast<double>(sourceHeight) /
        static_cast<double>(letterbox.contentHeight);
    const double srcBottom =
        static_cast<double>(y + 1u) * static_cast<double>(sourceHeight) /
        static_cast<double>(letterbox.contentHeight);
    const uint32_t dstY = letterbox.contentY + y;
    for (uint32_t x = 0; x < letterbox.contentWidth; ++x) {
      const double srcLeft =
          static_cast<double>(x) * static_cast<double>(sourceWidth) /
          static_cast<double>(letterbox.contentWidth);
      const double srcRight =
          static_cast<double>(x + 1u) * static_cast<double>(sourceWidth) /
          static_cast<double>(letterbox.contentWidth);
      const uint32_t dstX = letterbox.contentX + x;
      const uint32_t dstOffset = dstY * letterbox.inputWidth + dstX;
      for (uint32_t channel = 0; channel < 3u; ++channel) {
        mapping.push_back(TensorSampleMapping{
            static_cast<uint32_t>(planeSize * channel + dstOffset),
            channel,
            dstX,
            dstY,
            srcLeft,
            srcTop,
            srcRight,
            srcBottom,
        });
      }
    }
  }
  return mapping;
}

#ifdef _WIN32
namespace {

struct PreprocessUniforms {
  uint32_t sourceWidth;
  uint32_t sourceHeight;
  uint32_t tensorSize;
  uint32_t format;
  uint32_t contentX;
  uint32_t contentY;
  uint32_t contentWidth;
  uint32_t contentHeight;
};

constexpr const char *kPreprocessShaderSource = R"HLSL(
cbuffer PreprocessUniforms : register(b0) {
  uint sourceWidth;
  uint sourceHeight;
  uint tensorSize;
  uint format;
  uint contentX;
  uint contentY;
  uint contentWidth;
  uint contentHeight;
};

Texture2D<float> lumaTex : register(t0);
Texture2D<float2> chromaTex : register(t1);
Texture2D<float4> yuy2Tex : register(t2);
RWByteAddressBuffer tensorOut : register(u0);

float3 yuvToRgb(float y, float u, float v) {
  const float yy = max((y * 255.0 - 16.0) / 219.0, 0.0);
  const float uu = (u * 255.0 - 128.0) / 224.0;
  const float vv = (v * 255.0 - 128.0) / 224.0;
  return saturate(float3(yy + 1.5748 * vv,
                         yy - 0.1873 * uu - 0.4681 * vv,
                         yy + 1.8556 * uu));
}

void storeFloat(uint index, float value) {
  tensorOut.Store(index * 4u, asuint((value - 0.5) / 0.5));
}

[numthreads(8, 8, 1)]
void preprocess(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= tensorSize || gid.y >= tensorSize) {
    return;
  }
  const uint dstOffset = gid.y * tensorSize + gid.x;
  const uint planeSize = tensorSize * tensorSize;
  if (gid.x < contentX || gid.x >= contentX + contentWidth ||
      gid.y < contentY || gid.y >= contentY + contentHeight) {
    storeFloat(dstOffset, 0.5);
    storeFloat(planeSize + dstOffset, 0.5);
    storeFloat(planeSize * 2u + dstOffset, 0.5);
    return;
  }
  const float2 local = float2(gid.x - contentX + 0.5, gid.y - contentY + 0.5);
  const uint2 src = uint2(min(uint(local.x * sourceWidth / max(contentWidth, 1u)), sourceWidth - 1u),
                          min(uint(local.y * sourceHeight / max(contentHeight, 1u)), sourceHeight - 1u));
  float3 rgb;
  if (format == 0u) {
    const float y = lumaTex.Load(uint3(src, 0));
    const float2 uv = chromaTex.Load(uint3(src / 2u, 0));
    rgb = yuvToRgb(y, uv.x, uv.y);
  } else {
    const float4 pair = yuy2Tex.Load(uint3(src.x / 2u, src.y, 0));
    const float y = (src.x & 1u) == 0u ? pair.x : pair.z;
    rgb = yuvToRgb(y, pair.y, pair.w);
  }
  storeFloat(dstOffset, rgb.r);
  storeFloat(planeSize + dstOffset, rgb.g);
  storeFloat(planeSize * 2u + dstOffset, rgb.b);
}
)HLSL";

}  // namespace

bool GpuPreprocessorWin::ensureInitialized() {
  if (initialized_) {
    return available_;
  }
  initialized_ = true;
  if (!meetingGpuResidentEnabled() || !GpuContextWin::shared().available()) {
    return false;
  }
  available_ = compileShader();
  return available_;
}

bool GpuPreprocessorWin::compileShader() {
  ComPtr<ID3DBlob> blob;
  ComPtr<ID3DBlob> errors;
  HRESULT hr = D3DCompile(kPreprocessShaderSource, std::strlen(kPreprocessShaderSource),
                          "gpu_preprocess", nullptr, nullptr, "preprocess",
                          "cs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &blob,
                          &errors);
  if (FAILED(hr)) {
    return false;
  }
  GpuContextWin &gpu = GpuContextWin::shared();
  hr = gpu.d3d11Device()->CreateComputeShader(blob->GetBufferPointer(),
                                              blob->GetBufferSize(), nullptr,
                                              &shader_);
  if (FAILED(hr)) {
    return false;
  }
  D3D11_BUFFER_DESC uniformDesc{};
  uniformDesc.ByteWidth = (sizeof(PreprocessUniforms) + 15u) & ~15u;
  uniformDesc.Usage = D3D11_USAGE_DEFAULT;
  uniformDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  return SUCCEEDED(gpu.d3d11Device()->CreateBuffer(&uniformDesc, nullptr,
                                                   &uniforms_));
}

bool GpuPreprocessorWin::ensureSlot(uint32_t index, uint32_t tensorSize) {
  GpuPreprocessSlot &slot = slots_[index % 3u];
  if (slot.d3d11Buffer && slot.tensorSize == tensorSize) {
    return true;
  }
  slot = {};
  const UINT bytes = tensorSize * tensorSize * 3u * sizeof(float);
  D3D11_BUFFER_DESC desc{};
  desc.ByteWidth = bytes;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
                   D3D11_RESOURCE_MISC_SHARED |
                   D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
  GpuContextWin &gpu = GpuContextWin::shared();
  if (FAILED(gpu.d3d11Device()->CreateBuffer(&desc, nullptr, &slot.d3d11Buffer))) {
    return false;
  }
  D3D11_UNORDERED_ACCESS_VIEW_DESC uavDesc{};
  uavDesc.Format = DXGI_FORMAT_R32_TYPELESS;
  uavDesc.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
  uavDesc.Buffer.NumElements = bytes / 4u;
  uavDesc.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
  if (FAILED(gpu.d3d11Device()->CreateUnorderedAccessView(slot.d3d11Buffer.Get(),
                                                          &uavDesc, &slot.uav))) {
    return false;
  }
  ComPtr<IDXGIResource1> dxgiResource;
  HANDLE rawHandle = nullptr;
  if (FAILED(slot.d3d11Buffer.As(&dxgiResource)) ||
      FAILED(dxgiResource->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr,
                                              &rawHandle))) {
    return false;
  }
  slot.sharedHandle.Attach(rawHandle);
  if (FAILED(gpu.d3d12Device()->OpenSharedHandle(slot.sharedHandle.Get(),
                                                 IID_PPV_ARGS(&slot.d3d12Buffer)))) {
    return false;
  }
  slot.tensorSize = tensorSize;
  return true;
}

bool GpuPreprocessorWin::preprocess(ID3D11Texture2D *cameraTexture,
                                    uint32_t subresource,
                                    GpuCameraFormat format,
                                    uint32_t sourceWidth,
                                    uint32_t sourceHeight,
                                    uint32_t tensorSize,
                                    const ModnetLetterboxMapping &letterbox,
                                    GpuFrameSlot frameSlot) {
  (void)subresource;
  if (cameraTexture == nullptr || !ensureInitialized() ||
      !ensureSlot(frameSlot.index, tensorSize)) {
    return false;
  }
  PreprocessUniforms uniforms{sourceWidth, sourceHeight, tensorSize,
                              format == GpuCameraFormat::Nv12 ? 0u : 1u,
                              letterbox.contentX, letterbox.contentY,
                              letterbox.contentWidth, letterbox.contentHeight};
  GpuContextWin &gpu = GpuContextWin::shared();
  gpu.d3d11Context()->UpdateSubresource(uniforms_.Get(), 0, nullptr,
                                        &uniforms, 0, 0);
  ID3D11UnorderedAccessView *uavs[1] = {slots_[frameSlot.index % 3u].uav.Get()};
  ID3D11Buffer *cbs[1] = {uniforms_.Get()};
  gpu.d3d11Context()->CSSetShader(shader_.Get(), nullptr, 0);
  gpu.d3d11Context()->CSSetConstantBuffers(0, 1, cbs);
  gpu.d3d11Context()->CSSetUnorderedAccessViews(0, 1, uavs, nullptr);
  gpu.d3d11Context()->Dispatch((tensorSize + 7u) / 8u, (tensorSize + 7u) / 8u, 1u);
  ID3D11UnorderedAccessView *nullUav[1] = {nullptr};
  gpu.d3d11Context()->CSSetUnorderedAccessViews(0, 1, nullUav, nullptr);
  return gpu.signalFromD3D11(frameSlot.fenceValue);
}

const GpuPreprocessSlot *GpuPreprocessorWin::slot(uint32_t index) const {
  return &slots_[index % 3u];
}
#endif

}  // namespace broadify::meeting
