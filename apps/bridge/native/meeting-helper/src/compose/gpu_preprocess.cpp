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

using Microsoft::WRL::ComPtr;

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

float3 sampleCameraRgb(uint2 src) {
  if (format == 0u) {
    const float y = lumaTex.Load(uint3(src, 0));
    const float2 uv = chromaTex.Load(uint3(src / 2u, 0));
    return yuvToRgb(y, uv.x, uv.y);
  }
  const float4 pair = yuy2Tex.Load(uint3(src.x / 2u, src.y, 0));
  const float y = (src.x & 1u) == 0u ? pair.x : pair.z;
  return yuvToRgb(y, pair.y, pair.w);
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
  const float srcLeft = float(gid.x - contentX) * float(sourceWidth) / float(max(contentWidth, 1u));
  const float srcRight = float(gid.x - contentX + 1u) * float(sourceWidth) / float(max(contentWidth, 1u));
  const float srcTop = float(gid.y - contentY) * float(sourceHeight) / float(max(contentHeight, 1u));
  const float srcBottom = float(gid.y - contentY + 1u) * float(sourceHeight) / float(max(contentHeight, 1u));
  const uint xStart = min(uint(floor(srcLeft)), sourceWidth - 1u);
  const uint yStart = min(uint(floor(srcTop)), sourceHeight - 1u);
  const uint xEnd = min(uint(ceil(srcRight)), sourceWidth);
  const uint yEnd = min(uint(ceil(srcBottom)), sourceHeight);
  float3 rgbSum = float3(0.0, 0.0, 0.0);
  float weightTotal = 0.0;
  for (uint y = yStart; y < yEnd; ++y) {
    const float yWeight = max(0.0, min(srcBottom, float(y + 1u)) - max(srcTop, float(y)));
    for (uint x = xStart; x < xEnd; ++x) {
      const float xWeight = max(0.0, min(srcRight, float(x + 1u)) - max(srcLeft, float(x)));
      const float weight = xWeight * yWeight;
      if (weight > 0.0) {
        rgbSum += sampleCameraRgb(uint2(x, y)) * weight;
        weightTotal += weight;
      }
    }
  }
  const float3 rgb = weightTotal > 0.0 ? rgbSum / weightTotal : float3(0.5, 0.5, 0.5);
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
  GpuContextWin &gpu = GpuContextWin::shared();
  D3D12_HEAP_PROPERTIES heapProps{};
  heapProps.Type = D3D12_HEAP_TYPE_DEFAULT;
  D3D12_RESOURCE_DESC resourceDesc{};
  resourceDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  resourceDesc.Width = bytes;
  resourceDesc.Height = 1;
  resourceDesc.DepthOrArraySize = 1;
  resourceDesc.MipLevels = 1;
  resourceDesc.SampleDesc.Count = 1;
  resourceDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  resourceDesc.Flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
  if (FAILED(gpu.d3d12Device()->CreateCommittedResource(
          &heapProps, D3D12_HEAP_FLAG_SHARED, &resourceDesc,
          D3D12_RESOURCE_STATE_UNORDERED_ACCESS, nullptr,
          IID_PPV_ARGS(&slot.d3d12Buffer)))) {
    return false;
  }
  HANDLE rawHandle = nullptr;
  if (FAILED(gpu.d3d12Device()->CreateSharedHandle(
          slot.d3d12Buffer.Get(), nullptr, GENERIC_ALL, nullptr, &rawHandle))) {
    return false;
  }
  slot.sharedHandle.Attach(rawHandle);
  if (FAILED(gpu.d3d11Device()->OpenSharedResource1(
          slot.sharedHandle.Get(), IID_PPV_ARGS(&slot.d3d11Buffer)))) {
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
  slot.tensorSize = tensorSize;
  return true;
}

bool createCameraSrvs(ID3D11Device5 *device,
                      ID3D11Texture2D *cameraTexture,
                      uint32_t subresource,
                      GpuCameraFormat format,
                      ComPtr<ID3D11ShaderResourceView> &lumaSrv,
                      ComPtr<ID3D11ShaderResourceView> &chromaSrv,
                      ComPtr<ID3D11ShaderResourceView> &yuy2Srv) {
  D3D11_TEXTURE2D_DESC texDesc{};
  cameraTexture->GetDesc(&texDesc);
  const UINT firstArraySlice = texDesc.ArraySize > 1u ? subresource : 0u;
  if (format == GpuCameraFormat::Nv12) {
    D3D11_SHADER_RESOURCE_VIEW_DESC yDesc{};
    yDesc.Format = DXGI_FORMAT_R8_UNORM;
    yDesc.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2DARRAY;
    yDesc.Texture2DArray.MostDetailedMip = 0;
    yDesc.Texture2DArray.MipLevels = 1;
    yDesc.Texture2DArray.FirstArraySlice = firstArraySlice;
    yDesc.Texture2DArray.ArraySize = 1;
    D3D11_SHADER_RESOURCE_VIEW_DESC uvDesc = yDesc;
    uvDesc.Format = DXGI_FORMAT_R8G8_UNORM;
    return SUCCEEDED(device->CreateShaderResourceView(cameraTexture, &yDesc,
                                                      &lumaSrv)) &&
           SUCCEEDED(device->CreateShaderResourceView(cameraTexture, &uvDesc,
                                                      &chromaSrv));
  }
  D3D11_SHADER_RESOURCE_VIEW_DESC desc{};
  desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  desc.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2DARRAY;
  desc.Texture2DArray.MostDetailedMip = 0;
  desc.Texture2DArray.MipLevels = 1;
  desc.Texture2DArray.FirstArraySlice = firstArraySlice;
  desc.Texture2DArray.ArraySize = 1;
  return SUCCEEDED(device->CreateShaderResourceView(cameraTexture, &desc,
                                                    &yuy2Srv));
}

bool GpuPreprocessorWin::preprocess(ID3D11Texture2D *cameraTexture,
                                    uint32_t subresource,
                                    GpuCameraFormat format,
                                    uint32_t sourceWidth,
                                    uint32_t sourceHeight,
                                    uint32_t tensorSize,
                                    const ModnetLetterboxMapping &letterbox,
                                    GpuFrameSlot frameSlot) {
  if (cameraTexture == nullptr || !ensureInitialized() ||
      !ensureSlot(frameSlot.index, tensorSize)) {
    return false;
  }
  ComPtr<ID3D11ShaderResourceView> lumaSrv;
  ComPtr<ID3D11ShaderResourceView> chromaSrv;
  ComPtr<ID3D11ShaderResourceView> yuy2Srv;
  GpuContextWin &gpu = GpuContextWin::shared();
  if (!createCameraSrvs(gpu.d3d11Device(), cameraTexture, subresource, format,
                        lumaSrv, chromaSrv, yuy2Srv)) {
    return false;
  }
  PreprocessUniforms uniforms{sourceWidth, sourceHeight, tensorSize,
                              format == GpuCameraFormat::Nv12 ? 0u : 1u,
                              letterbox.contentX, letterbox.contentY,
                              letterbox.contentWidth, letterbox.contentHeight};
  {
    std::lock_guard<std::mutex> lock(gpu.immediateContextMutex());
    gpu.d3d11Context()->UpdateSubresource(uniforms_.Get(), 0, nullptr,
                                          &uniforms, 0, 0);
    ID3D11ShaderResourceView *srvs[3] = {lumaSrv.Get(), chromaSrv.Get(),
                                         yuy2Srv.Get()};
    ID3D11UnorderedAccessView *uavs[1] = {slots_[frameSlot.index % 3u].uav.Get()};
    ID3D11Buffer *cbs[1] = {uniforms_.Get()};
    gpu.d3d11Context()->CSSetShader(shader_.Get(), nullptr, 0);
    gpu.d3d11Context()->CSSetConstantBuffers(0, 1, cbs);
    gpu.d3d11Context()->CSSetShaderResources(0, 3, srvs);
    gpu.d3d11Context()->CSSetUnorderedAccessViews(0, 1, uavs, nullptr);
    gpu.d3d11Context()->Dispatch((tensorSize + 7u) / 8u,
                                 (tensorSize + 7u) / 8u, 1u);
    ID3D11UnorderedAccessView *nullUav[1] = {nullptr};
    ID3D11ShaderResourceView *nullSrvs[3] = {};
    gpu.d3d11Context()->CSSetUnorderedAccessViews(0, 1, nullUav, nullptr);
    gpu.d3d11Context()->CSSetShaderResources(0, 3, nullSrvs);
  }
  return gpu.signalFromD3D11(frameSlot.fenceValue);
}

const GpuPreprocessSlot *GpuPreprocessorWin::slot(uint32_t index) const {
  return &slots_[index % 3u];
}
#endif

}  // namespace broadify::meeting
