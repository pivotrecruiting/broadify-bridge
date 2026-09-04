#include "compose/d3d11_compositor.h"
#include "compose/d3d_adapter_select.h"
#include "compose/staging_readback_ring.h"
#include "pipeline/guided_work_size.h"

// D3D11 port of the Metal GPU compositor (metal_compositor.mm): one compute
// dispatch composites background (mode/company image), back graphics, the
// keyed presenter (or cover camera), the media layer and front graphics into
// an RGBA program frame. Default ON (matching the macOS Metal path); the
// kill-switch BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=0 forces the CPU
// compositor, and every failure also falls back to the CPU compositor.
//
// The HLSL kernel below is a line-for-line port of the MSL kernel so both
// backends stay pixel-equivalent; keep them in sync.

#include <windows.h>

#include <d3d11.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace broadify::meeting {
namespace {

// Must match the HLSL cbuffer below (rows of four 32-bit values).
struct ComposeUniforms {
  uint32_t width;
  uint32_t height;
  uint32_t backgroundMode;
  uint32_t frameIndex96;

  uint32_t cameraPresent;
  uint32_t cameraKeyed;
  uint32_t cameraMirror;
  uint32_t backPresent;

  float camScaleX;
  float camScaleY;
  float camBiasX;
  float camBiasY;

  float camMirrorConst;
  float camTexWidth;
  float camTexHeight;
  float backMirrorConst;

  float backScaleX;
  float backScaleY;
  float backBiasX;
  float backBiasY;

  uint32_t frontPresent;
  float frontScaleX;
  float frontScaleY;
  float frontBiasX;

  float frontBiasY;
  float pad0;
  float pad1;
  float pad2;

  uint32_t mediaPresent;
  uint32_t mediaBelowCamera;
  uint32_t shadowPresent;
  uint32_t padM;

  float m00; float m01; float m02; float m10;
  float m11; float m12; float m20; float m21;
  float m22; float s00; float s01; float s02;
  float s10; float s11; float s12; float s20;
  float s21; float s22; float padM1; float padM2;

  uint32_t maskPresent;
  uint32_t padK0;
  uint32_t padK1;
  uint32_t padK2;

  uint32_t bgImagePresent;
  float bgImgScaleX;
  float bgImgScaleY;
  float bgImgBiasX;

  float bgImgBiasY;
  float padBG0;
  float padBG1;
  float padBG2;
};

constexpr const char *kComposeShaderSource = R"HLSL(
cbuffer ComposeUniforms : register(b0) {
  uint width;
  uint height;
  uint backgroundMode;
  uint frameIndex96;

  uint cameraPresent;
  uint cameraKeyed;
  uint cameraMirror;
  uint backPresent;

  float camScaleX;
  float camScaleY;
  float camBiasX;
  float camBiasY;

  float camMirrorConst;
  float camTexWidth;
  float camTexHeight;
  float backMirrorConst;

  float backScaleX;
  float backScaleY;
  float backBiasX;
  float backBiasY;

  uint frontPresent;
  float frontScaleX;
  float frontScaleY;
  float frontBiasX;

  float frontBiasY;
  float pad0;
  float pad1;
  float pad2;

  uint mediaPresent;
  uint mediaBelowCamera;
  uint shadowPresent;
  uint padM;

  float m00; float m01; float m02; float m10;
  float m11; float m12; float m20; float m21;
  float m22; float s00; float s01; float s02;
  float s10; float s11; float s12; float s20;
  float s21; float s22; float padM1; float padM2;

  uint maskPresent;
  uint padK0;
  uint padK1;
  uint padK2;

  uint bgImagePresent;
  float bgImgScaleX;
  float bgImgScaleY;
  float bgImgBiasX;

  float bgImgBiasY;
  float padBG0;
  float padBG1;
  float padBG2;
};

Texture2D<float4> cameraTex : register(t0);
Texture2D<float4> backTex : register(t1);
Texture2D<float4> frontTex : register(t2);
Texture2D<float4> mediaTex : register(t3);
Texture2D<float4> maskTex : register(t4);
Texture2D<float4> bgImageTex : register(t5);
SamplerState layerSampler : register(s0);
RWByteAddressBuffer output : register(u0);

float4 sampleLayer(Texture2D<float4> layer, float2 sourcePx) {
  float texW, texH;
  layer.GetDimensions(texW, texH);
  const float2 uv = (sourcePx + 0.5) / float2(texW, texH);
  return layer.SampleLevel(layerSampler, uv, 0);
}

// Media (PiP) layer: inverse-homography lookup into the fitted image quad,
// preceded by the optional planar drop shadow quad.
float3 blendMedia(float3 rgb, float2 dest) {
  if (shadowPresent != 0u) {
    const float sw = s20 * dest.x + s21 * dest.y + s22;
    if (abs(sw) > 1e-9) {
      const float su = (s00 * dest.x + s01 * dest.y + s02) / sw;
      const float sv = (s10 * dest.x + s11 * dest.y + s12) / sw;
      if (su >= 0.0 && su <= 1.0 && sv >= 0.0 && sv <= 1.0) {
        rgb = lerp(rgb, float3(0.0, 0.0, 0.0), 46.0 / 255.0);
      }
    }
  }
  const float w = m20 * dest.x + m21 * dest.y + m22;
  if (abs(w) < 1e-9) {
    return rgb;
  }
  const float mu = (m00 * dest.x + m01 * dest.y + m02) / w;
  const float mv = (m10 * dest.x + m11 * dest.y + m12) / w;
  if (mu < 0.0 || mu > 1.0 || mv < 0.0 || mv > 1.0) {
    return rgb;
  }
  float texW, texH;
  mediaTex.GetDimensions(texW, texH);
  const float4 s = sampleLayer(mediaTex, float2(mu, mv) * float2(texW, texH) - 0.5);
  const float a = s.a;
  const float3 c = a > 0.001 ? min(s.rgb / a, 1.0) : float3(0.0, 0.0, 0.0);
  return lerp(rgb, c, a);
}

[numthreads(8, 8, 1)]
void composeProgram(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= width || gid.y >= height) {
    return;
  }

  const float2 dest = float2(gid.xy) + 0.5;
  float3 rgb;

  // Background (matches fillBackground on the CPU path).
  if (backgroundMode == 1u) {  // animated gradient
    const uint wave = (gid.x + gid.y + frameIndex96) % 96u;
    const float r = clamp(20.0 + (120.0 * float(gid.x)) / float(max(width, 1u)) + float(wave / 5u), 0.0, 255.0);
    const float g = clamp(54.0 + (90.0 * float(gid.y)) / float(max(height, 1u)), 0.0, 255.0);
    const float b = clamp(94.0 + float(wave), 0.0, 255.0);
    rgb = float3(r, g, b) / 255.0;
  } else if (backgroundMode == 2u) {
    rgb = float3(232.0, 236.0, 229.0) / 255.0;
  } else if (backgroundMode == 3u) {
    const bool tile = ((gid.x / 48u) + (gid.y / 48u)) % 2u == 0u;
    rgb = (tile ? float3(42.0, 45.0, 50.0) : float3(70.0, 74.0, 82.0)) / 255.0;
  } else if (backgroundMode == 4u) {
    rgb = float3(0.0, 0.0, 0.0);
  } else {
    rgb = float3(8.0, 10.0, 14.0) / 255.0;
  }

  // Uploaded company background image (cover-cropped, below all layers).
  if (bgImagePresent != 0u) {
    const float2 src = float2(dest.x * bgImgScaleX + bgImgBiasX, dest.y * bgImgScaleY + bgImgBiasY);
    const float4 s = sampleLayer(bgImageTex, src);
    rgb = lerp(rgb, s.rgb, s.a);
  }

  // Back graphics (cover-cropped full-frame layer).
  if (backPresent != 0u) {
    const float2 src = float2(dest.x * backScaleX + backBiasX, dest.y * backScaleY + backBiasY);
    const float4 s = sampleLayer(backTex, src);
    rgb = lerp(rgb, s.rgb, s.a);
  }

  if (mediaPresent != 0u && mediaBelowCamera != 0u) {
    rgb = blendMedia(rgb, dest);
  }

  // Camera layer: keyed presenter (transform anchored to the keyed bottom
  // edge) or full-frame cover camera.
  if (cameraPresent != 0u) {
    float2 src = float2(dest.x * camScaleX + camBiasX, dest.y * camScaleY + camBiasY);
    if (cameraMirror != 0u) {
      src.x = camMirrorConst - src.x;
    }
    if (src.x >= 0.0 && src.x <= camTexWidth - 1.0 && src.y >= 0.0 && src.y <= camTexHeight - 1.0) {
      const float4 s = sampleLayer(cameraTex, src);
      float alpha = s.a;
      if (cameraKeyed != 0u) {
        // Keyer mask stretched over the camera frame. The alpha curve lives
        // in postprocessAlpha; do not apply a second compositor curve here.
        alpha = 0.0;
        if (maskPresent != 0u) {
          const float2 uv = (src + 0.5) / float2(camTexWidth, camTexHeight);
          alpha = maskTex.SampleLevel(layerSampler, uv, 0).r;
          // Only clip truly negligible alpha; keep the soft hair/edge band that
          // the old 24.5/255 snap discarded.
          if (alpha <= 8.0 / 255.0) {
            alpha = 0.0;
          }
        }
      }
      rgb = lerp(rgb, s.rgb, alpha);
    }
  }

  if (mediaPresent != 0u && mediaBelowCamera == 0u) {
    rgb = blendMedia(rgb, dest);
  }

  // Front graphics.
  if (frontPresent != 0u) {
    const float2 src = float2(dest.x * frontScaleX + frontBiasX, dest.y * frontScaleY + frontBiasY);
    const float4 s = sampleLayer(frontTex, src);
    rgb = lerp(rgb, s.rgb, s.a);
  }

  const uint index = gid.y * width + gid.x;
  const float3 scaled = clamp(rgb, 0.0, 1.0) * 255.0 + 0.5;
  const uint packed = uint(scaled.r) | (uint(scaled.g) << 8) | (uint(scaled.b) << 16) | (255u << 24);
  output.Store(index * 4u, packed);
}
)HLSL";

struct LayerTexture {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<ID3D11ShaderResourceView> srv;
  uint64_t timestampNs = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

struct D3D11Context {
  bool initialized = false;
  bool available = false;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11ComputeShader> shader;
  ComPtr<ID3D11Buffer> uniforms;
  ComPtr<ID3D11SamplerState> sampler;
  ComPtr<ID3D11Buffer> outputBuffer;
  ComPtr<ID3D11UnorderedAccessView> outputUav;
  std::vector<ComPtr<ID3D11Buffer>> stagingBuffers;
  StagingReadbackRing stagingRing;
  size_t outputBufferSize = 0;
  LayerTexture camera;
  LayerTexture back;
  LayerTexture front;
  LayerTexture media;
  LayerTexture mask;
  LayerTexture backgroundImage;
  uint64_t cameraUploadCount = 0;
  double cameraUploadMs = -1.0;
};

// The program loop is the only caller, so no locking is needed.
D3D11Context &context() {
  static D3D11Context ctx;
  return ctx;
}

void logCompositorEvent(const char *event, const std::string &detail) {
  std::cout << "{\"type\":\"meeting_gpu_compositor\",\"backend\":\"d3d11\",\"event\":\""
            << event << "\",\"detail\":\"" << detail << "\"}" << std::endl;
}

std::string hresultDetail(HRESULT hr) {
  char buffer[32];
  snprintf(buffer, sizeof(buffer), "hr=0x%08lX", static_cast<unsigned long>(hr));
  return buffer;
}

bool initializeContext() {
  D3D11Context &ctx = context();
  if (ctx.initialized) {
    return ctx.available;
  }
  ctx.initialized = true;

  // Default ON (proven in the field): the D3D11 GPU compositor is the Windows
  // production path, matching the macOS Metal opt-OUT. Kill-switch: set
  // BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=0 to fall back to the CPU compositor.
  const char *envToggle = std::getenv("BROADIFY_MEETING_GPU_COMPOSITOR_D3D11");
  if (envToggle != nullptr && std::strcmp(envToggle, "0") == 0) {
    logCompositorEvent("disabled",
                       "BROADIFY_MEETING_GPU_COMPOSITOR_D3D11=0 (CPU compositor)");
    return false;
  }

  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1,
                                      D3D_FEATURE_LEVEL_11_0};
  D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;
  const D3DAdapterInfo &adapter = sharedD3DAdapter();
  HRESULT hr = D3D11CreateDevice(
      adapter.available ? adapter.adapter.Get() : nullptr,
      adapter.available ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
      nullptr, 0, levels,
      static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION, &ctx.device,
      &got, &ctx.context);
  if (FAILED(hr)) {
    logCompositorEvent("unavailable", "no D3D11 hardware device, " + hresultDetail(hr));
    return false;
  }

  ComPtr<ID3DBlob> blob;
  ComPtr<ID3DBlob> errors;
  hr = D3DCompile(kComposeShaderSource, std::strlen(kComposeShaderSource),
                  "compose_program", nullptr, nullptr, "composeProgram",
                  "cs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &blob, &errors);
  if (FAILED(hr)) {
    const std::string detail =
        errors ? std::string(static_cast<const char *>(errors->GetBufferPointer()),
                             errors->GetBufferSize())
               : hresultDetail(hr);
    logCompositorEvent("shader_compile_failed", detail.substr(0, 300));
    return false;
  }
  hr = ctx.device->CreateComputeShader(blob->GetBufferPointer(),
                                       blob->GetBufferSize(), nullptr,
                                       &ctx.shader);
  if (FAILED(hr)) {
    logCompositorEvent("pipeline_failed", hresultDetail(hr));
    return false;
  }

  D3D11_BUFFER_DESC uniformDesc{};
  uniformDesc.ByteWidth = (sizeof(ComposeUniforms) + 15u) & ~15u;
  uniformDesc.Usage = D3D11_USAGE_DEFAULT;
  uniformDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  hr = ctx.device->CreateBuffer(&uniformDesc, nullptr, &ctx.uniforms);
  if (FAILED(hr)) {
    logCompositorEvent("uniforms_failed", hresultDetail(hr));
    return false;
  }

  D3D11_SAMPLER_DESC samplerDesc{};
  samplerDesc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  samplerDesc.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
  samplerDesc.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
  samplerDesc.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  samplerDesc.MaxLOD = D3D11_FLOAT32_MAX;
  hr = ctx.device->CreateSamplerState(&samplerDesc, &ctx.sampler);
  if (FAILED(hr)) {
    logCompositorEvent("sampler_failed", hresultDetail(hr));
    return false;
  }

  ctx.available = true;
  logCompositorEvent("enabled", "feature level " +
                                    std::to_string((got >> 12) & 0xF) + "_" +
                                    std::to_string((got >> 8) & 0xF));
  return true;
}

bool ensureOutputBuffers(uint32_t width, uint32_t height) {
  D3D11Context &ctx = context();
  const size_t needed = static_cast<size_t>(width) * height * 4u;
  if (ctx.outputBuffer && ctx.outputBufferSize == needed) {
    return true;
  }
  ctx.outputBuffer.Reset();
  ctx.outputUav.Reset();
  ctx.stagingBuffers.clear();
  ctx.stagingRing.reset();

  D3D11_BUFFER_DESC bufferDesc{};
  bufferDesc.ByteWidth = static_cast<UINT>(needed);
  bufferDesc.Usage = D3D11_USAGE_DEFAULT;
  bufferDesc.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
  bufferDesc.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
  if (FAILED(ctx.device->CreateBuffer(&bufferDesc, nullptr, &ctx.outputBuffer))) {
    return false;
  }
  D3D11_UNORDERED_ACCESS_VIEW_DESC uavDesc{};
  uavDesc.Format = DXGI_FORMAT_R32_TYPELESS;
  uavDesc.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
  uavDesc.Buffer.NumElements = static_cast<UINT>(needed / 4u);
  uavDesc.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
  if (FAILED(ctx.device->CreateUnorderedAccessView(ctx.outputBuffer.Get(),
                                                   &uavDesc, &ctx.outputUav))) {
    return false;
  }
  ctx.stagingBuffers.resize(ctx.stagingRing.depth());
  for (auto &stagingBuffer : ctx.stagingBuffers) {
    D3D11_BUFFER_DESC stagingDesc{};
    stagingDesc.ByteWidth = static_cast<UINT>(needed);
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(ctx.device->CreateBuffer(&stagingDesc, nullptr, &stagingBuffer))) {
      ctx.stagingBuffers.clear();
      return false;
    }
  }
  ctx.outputBufferSize = needed;
  return true;
}

bool mapReadbackRing(ID3D11DeviceContext *context,
                     std::vector<ComPtr<ID3D11Buffer>> &stagingBuffers,
                     StagingReadbackRing &ring,
                     ID3D11Resource *source,
                     D3D11_MAPPED_SUBRESOURCE *mapped,
                     size_t *mappedIndex) {
  const StagingReadbackDecision decision = ring.advance();
  context->CopyResource(stagingBuffers[decision.copyIndex].Get(), source);
  if (!decision.preferredMapValid) {
    HRESULT hr = context->Map(stagingBuffers[decision.copyIndex].Get(), 0,
                              D3D11_MAP_READ, 0, mapped);
    if (FAILED(hr)) {
      return false;
    }
    *mappedIndex = decision.copyIndex;
    return true;
  }
  HRESULT hr = context->Map(stagingBuffers[decision.preferredMapIndex].Get(), 0,
                            D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, mapped);
  if (SUCCEEDED(hr)) {
    *mappedIndex = decision.preferredMapIndex;
    return true;
  }
  if (hr != DXGI_ERROR_WAS_STILL_DRAWING || !decision.allowBlockingFallback) {
    return false;
  }
  hr = context->Map(stagingBuffers[decision.fallbackMapIndex].Get(), 0,
                    D3D11_MAP_READ, 0, mapped);
  if (FAILED(hr)) {
    return false;
  }
  *mappedIndex = decision.fallbackMapIndex;
  return true;
}

bool stagingRingEnabled() {
  // Default ON: the compose readback pipelines through a depth-3 staging ring
  // (maps frame N-1) instead of a blocking Map on the current frame, removing
  // a full GPU sync from the program loop every frame. Kill-switch: set
  // BROADIFY_MEETING_STAGING_RING=0 to restore the rc.18 blocking readback.
  // (rc.18 disabled this while chasing a ghosting regression whose actual
  // cause was the guided-mask readback, which stays current-frame here.)
  // Costs at most one extra frame of output latency.
  static const bool enabled = [] {
    const char *value = std::getenv("BROADIFY_MEETING_STAGING_RING");
    return value == nullptr || std::strcmp(value, "0") != 0;
  }();
  return enabled;
}

bool mapCurrentFrameReadback(ID3D11DeviceContext *context,
                             std::vector<ComPtr<ID3D11Buffer>> &stagingBuffers,
                             StagingReadbackRing &ring,
                             ID3D11Resource *source,
                             D3D11_MAPPED_SUBRESOURCE *mapped,
                             size_t *mappedIndex) {
  const StagingReadbackDecision decision = ring.advanceCurrentFrame();
  context->CopyResource(stagingBuffers[decision.copyIndex].Get(), source);
  HRESULT hr = context->Map(stagingBuffers[decision.preferredMapIndex].Get(), 0,
                            D3D11_MAP_READ, 0, mapped);
  if (FAILED(hr)) {
    return false;
  }
  *mappedIndex = decision.preferredMapIndex;
  return true;
}

// Uploads RGBA (or R8) pixels into the cached slot texture; skips the copy
// when the timestamp is unchanged (graphics layers repeat frames between
// updates, background/media images change only on program updates).
bool uploadLayer(LayerTexture &slot, const uint8_t *pixels, uint32_t width,
                 uint32_t height, uint64_t timestampNs, DXGI_FORMAT format,
                 uint32_t bytesPerPixel, bool *didUpload = nullptr) {
  if (didUpload != nullptr) {
    *didUpload = false;
  }
  if (pixels == nullptr || width == 0u || height == 0u) {
    return false;
  }
  D3D11Context &ctx = context();
  if (!slot.texture || slot.width != width || slot.height != height) {
    slot.texture.Reset();
    slot.srv.Reset();
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = format;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(ctx.device->CreateTexture2D(&desc, nullptr, &slot.texture))) {
      return false;
    }
    if (FAILED(ctx.device->CreateShaderResourceView(slot.texture.Get(), nullptr,
                                                    &slot.srv))) {
      slot.texture.Reset();
      return false;
    }
    slot.width = width;
    slot.height = height;
    slot.timestampNs = 0;
  }
  if (timestampNs == 0u || timestampNs != slot.timestampNs) {
    ctx.context->UpdateSubresource(slot.texture.Get(), 0, nullptr, pixels,
                                   width * bytesPerPixel, 0);
    slot.timestampNs = timestampNs;
    if (didUpload != nullptr) {
      *didUpload = true;
    }
  }
  return true;
}

bool uploadFrame(LayerTexture &slot, const VideoFrame *frame) {
  if (frame == nullptr || frame->rgba.empty()) {
    return false;
  }
  return uploadLayer(slot, frame->rgba.data(), frame->width, frame->height,
                     frame->timestampNs, DXGI_FORMAT_R8G8B8A8_UNORM, 4u);
}

bool uploadCameraFrame(const VideoFrame *frame) {
  if (frame == nullptr || frame->rgba.empty()) {
    return false;
  }
  bool didUpload = false;
  const auto uploadStart = std::chrono::steady_clock::now();
  if (!uploadLayer(context().camera, frame->rgba.data(), frame->width,
                   frame->height, frame->timestampNs,
                   DXGI_FORMAT_R8G8B8A8_UNORM, 4u, &didUpload)) {
    return false;
  }
  if (didUpload) {
    ++context().cameraUploadCount;
    const auto uploadEnd = std::chrono::steady_clock::now();
    context().cameraUploadMs =
        std::chrono::duration<double, std::milli>(uploadEnd - uploadStart).count();
  }
  return true;
}

}  // namespace

bool d3d11CompositorAvailable() {
  return initializeContext();
}

bool renderProgramFrameD3D11(const MetalComposePlan &plan,
                             std::vector<uint8_t> &output) {
  if (!initializeContext() || plan.width == 0u || plan.height == 0u) {
    return false;
  }
  D3D11Context &ctx = context();
  if (!ensureOutputBuffers(plan.width, plan.height)) {
    logCompositorEvent("output_alloc_failed", "");
    return false;
  }

  ComposeUniforms uniforms{};
  uniforms.width = plan.width;
  uniforms.height = plan.height;
  uniforms.backgroundMode = static_cast<uint32_t>(plan.backgroundMode);
  uniforms.frameIndex96 = static_cast<uint32_t>(plan.frameIndex % 96u);

  if (plan.camera.present && uploadCameraFrame(plan.cameraFrame)) {
    uniforms.cameraPresent = 1u;
    uniforms.cameraKeyed = plan.camera.keyed ? 1u : 0u;
    uniforms.cameraMirror = plan.camera.mirror ? 1u : 0u;
    uniforms.camScaleX = plan.camera.scaleX;
    uniforms.camScaleY = plan.camera.scaleY;
    uniforms.camBiasX = plan.camera.biasX;
    uniforms.camBiasY = plan.camera.biasY;
    uniforms.camMirrorConst = plan.camera.mirrorConst;
    uniforms.camTexWidth = static_cast<float>(plan.cameraFrame->width);
    uniforms.camTexHeight = static_cast<float>(plan.cameraFrame->height);
  }
  if (plan.backMapping.present && uploadFrame(ctx.back, plan.backGraphics)) {
    uniforms.backPresent = 1u;
    uniforms.backScaleX = plan.backMapping.scaleX;
    uniforms.backScaleY = plan.backMapping.scaleY;
    uniforms.backBiasX = plan.backMapping.biasX;
    uniforms.backBiasY = plan.backMapping.biasY;
  }
  if (plan.frontMapping.present && uploadFrame(ctx.front, plan.frontGraphics)) {
    uniforms.frontPresent = 1u;
    uniforms.frontScaleX = plan.frontMapping.scaleX;
    uniforms.frontScaleY = plan.frontMapping.scaleY;
    uniforms.frontBiasX = plan.frontMapping.biasX;
    uniforms.frontBiasY = plan.frontMapping.biasY;
  }
  if (plan.backgroundImage != nullptr && plan.backgroundImageWidth > 0u &&
      plan.backgroundImageHeight > 0u &&
      uploadLayer(ctx.backgroundImage, plan.backgroundImage,
                  plan.backgroundImageWidth, plan.backgroundImageHeight,
                  plan.backgroundImageCacheKey, DXGI_FORMAT_R8G8B8A8_UNORM,
                  4u)) {
    uniforms.bgImagePresent = 1u;
    uniforms.bgImgScaleX = plan.backgroundImageMapping.scaleX;
    uniforms.bgImgScaleY = plan.backgroundImageMapping.scaleY;
    uniforms.bgImgBiasX = plan.backgroundImageMapping.biasX;
    uniforms.bgImgBiasY = plan.backgroundImageMapping.biasY;
  }
  if (plan.media.present && plan.media.rgba != nullptr &&
      uploadLayer(ctx.media, plan.media.rgba, plan.media.width,
                  plan.media.height, plan.media.cacheKey,
                  DXGI_FORMAT_R8G8B8A8_UNORM, 4u)) {
    uniforms.mediaPresent = 1u;
    uniforms.mediaBelowCamera = plan.media.belowCamera ? 1u : 0u;
    uniforms.shadowPresent = plan.media.shadowPresent ? 1u : 0u;
    const float *m = plan.media.invHomography;
    uniforms.m00 = m[0]; uniforms.m01 = m[1]; uniforms.m02 = m[2];
    uniforms.m10 = m[3]; uniforms.m11 = m[4]; uniforms.m12 = m[5];
    uniforms.m20 = m[6]; uniforms.m21 = m[7]; uniforms.m22 = m[8];
    const float *sh = plan.media.shadowInvHomography;
    uniforms.s00 = sh[0]; uniforms.s01 = sh[1]; uniforms.s02 = sh[2];
    uniforms.s10 = sh[3]; uniforms.s11 = sh[4]; uniforms.s12 = sh[5];
    uniforms.s20 = sh[6]; uniforms.s21 = sh[7]; uniforms.s22 = sh[8];
  }
  if (plan.camera.keyed && plan.cameraMask != nullptr && plan.maskWidth > 0u &&
      plan.maskHeight > 0u &&
      uploadLayer(ctx.mask, plan.cameraMask, plan.maskWidth, plan.maskHeight,
                  plan.maskTimestampNs, DXGI_FORMAT_R8_UNORM, 1u)) {
    uniforms.maskPresent = 1u;
  }

  ctx.context->UpdateSubresource(ctx.uniforms.Get(), 0, nullptr, &uniforms, 0, 0);

  ID3D11ShaderResourceView *srvs[6] = {
      ctx.camera.srv.Get(), ctx.back.srv.Get(),  ctx.front.srv.Get(),
      ctx.media.srv.Get(),  ctx.mask.srv.Get(),  ctx.backgroundImage.srv.Get(),
  };
  ID3D11Buffer *cbs[1] = {ctx.uniforms.Get()};
  ID3D11SamplerState *samplers[1] = {ctx.sampler.Get()};
  ID3D11UnorderedAccessView *uavs[1] = {ctx.outputUav.Get()};
  ctx.context->CSSetShader(ctx.shader.Get(), nullptr, 0);
  ctx.context->CSSetConstantBuffers(0, 1, cbs);
  ctx.context->CSSetShaderResources(0, 6, srvs);
  ctx.context->CSSetSamplers(0, 1, samplers);
  ctx.context->CSSetUnorderedAccessViews(0, 1, uavs, nullptr);
  ctx.context->Dispatch((plan.width + 7u) / 8u, (plan.height + 7u) / 8u, 1u);

  // Unbind so the next frame's UpdateSubresource never hits a bound resource.
  ID3D11UnorderedAccessView *nullUav[1] = {nullptr};
  ID3D11ShaderResourceView *nullSrvs[6] = {};
  ctx.context->CSSetUnorderedAccessViews(0, 1, nullUav, nullptr);
  ctx.context->CSSetShaderResources(0, 6, nullSrvs);

  D3D11_MAPPED_SUBRESOURCE mapped{};
  size_t mappedIndex = 0;
  if (stagingRingEnabled()) {
    if (!mapReadbackRing(ctx.context.Get(), ctx.stagingBuffers, ctx.stagingRing,
                         ctx.outputBuffer.Get(), &mapped, &mappedIndex)) {
      logCompositorEvent("readback_pending", "staging ring not ready");
      return false;
    }
  } else {
    if (!mapCurrentFrameReadback(ctx.context.Get(), ctx.stagingBuffers,
                                 ctx.stagingRing, ctx.outputBuffer.Get(),
                                 &mapped, &mappedIndex)) {
      return false;
    }
  }
  output.resize(ctx.outputBufferSize);
  std::memcpy(output.data(), mapped.pData, ctx.outputBufferSize);
  ctx.context->Unmap(ctx.stagingBuffers[mappedIndex].Get(), 0);
  return true;
}

uint64_t d3d11CompositorCameraUploadCount() {
  return context().cameraUploadCount;
}

double d3d11CompositorCameraUploadMs() {
  return context().cameraUploadMs;
}

uint32_t d3d11CompositorStagingReadbackDepth() {
  return stagingRingEnabled() ? static_cast<uint32_t>(context().stagingRing.depth())
                              : 0u;
}

// ---------------------------------------------------------------------------
// GPU guided mask refine (Stufe 3): port of guidedRefineMask in
// guided_mask_refine.cpp. Same math, same working grid (<=512 wide), same
// radius/epsilon env overrides — the CPU implementation stays as the
// fallback and the reference for pixel-equivalence.
// ---------------------------------------------------------------------------

namespace {

struct GuidedUniforms {
  uint32_t workW;
  uint32_t workH;
  uint32_t radius;
  uint32_t horizontal;  // box blur direction
  float epsilon;
  float coeffEma;
  float pad1;
  float pad2;
};

constexpr const char *kGuidedShaderSource = R"HLSL(
cbuffer GuidedUniforms : register(b0) {
  uint workW;
  uint workH;
  uint radius;
  uint horizontal;
  float epsilon;
  float coeffEma;
  float pad1;
  float pad2;
};

Texture2D<float4> guideTex : register(t0);
Texture2D<float4> maskTex : register(t1);
Texture2D<float2> srcA : register(t2);
Texture2D<float2> srcB : register(t3);
SamplerState linearClamp : register(s0);
RWTexture2D<float2> outRG : register(u0);
RWByteAddressBuffer outBytes : register(u1);

// Pass 1: I = guide luma, p = mask, both bilinear-resampled onto the work grid
// (sampler at (x+0.5)/work matches the CPU resamplePlane coordinates).
[numthreads(8, 8, 1)]
void buildIp(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= workW || gid.y >= workH) return;
  const float2 uv = (float2(gid.xy) + 0.5) / float2(workW, workH);
  const float4 g = guideTex.SampleLevel(linearClamp, uv, 0);
  const float lum = dot(g.rgb, float3(0.299, 0.587, 0.114));
  const float p = maskTex.SampleLevel(linearClamp, uv, 0).r;
  outRG[gid.xy] = float2(lum, p);
}

// corr = (I*I, I*p) from the unblurred (I,p) plane.
[numthreads(8, 8, 1)]
void buildCorr(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= workW || gid.y >= workH) return;
  const float2 a = srcA[gid.xy];
  outRG[gid.xy] = float2(a.x * a.x, a.x * a.y);
}

// Separable box blur with border-correct averaging (divides by the actual
// in-bounds sample count) — identical to the CPU boxBlur.
[numthreads(8, 8, 1)]
void boxBlur(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= workW || gid.y >= workH) return;
  float2 sum = float2(0.0, 0.0);
  uint count = 0;
  if (horizontal != 0u) {
    const int lo = max(0, int(gid.x) - int(radius));
    const int hi = min(int(workW) - 1, int(gid.x) + int(radius));
    for (int x = lo; x <= hi; x++) {
      sum += srcA[uint2(uint(x), gid.y)];
      count++;
    }
  } else {
    const int lo = max(0, int(gid.y) - int(radius));
    const int hi = min(int(workH) - 1, int(gid.y) + int(radius));
    for (int y = lo; y <= hi; y++) {
      sum += srcA[uint2(gid.x, uint(y))];
      count++;
    }
  }
  outRG[gid.xy] = sum / float(max(count, 1u));
}

// a = covIp / (varI + eps), b = meanP - a * meanI.
// srcA = mean(I,p), srcB = mean(I*I, I*p).
[numthreads(8, 8, 1)]
void buildAb(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= workW || gid.y >= workH) return;
  const float2 mean = srcA[gid.xy];
  const float2 corr = srcB[gid.xy];
  const float varI = corr.x - mean.x * mean.x;
  const float covIp = corr.y - mean.x * mean.y;
  const float a = covIp / (varI + epsilon);
  outRG[gid.xy] = float2(a, mean.y - a * mean.x);
}

[numthreads(8, 8, 1)]
void blendAb(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= workW || gid.y >= workH) return;
  const float2 current = srcA[gid.xy];
  const float2 previous = srcB[gid.xy];
  outRG[gid.xy] = previous * (1.0 - coeffEma) + current * coeffEma;
}

// q = a*I + b -> uint8. srcA = original (I,p), srcB = mean(a,b).
[numthreads(8, 8, 1)]
void buildOutput(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= workW || gid.y >= workH) return;
  const float I = srcA[gid.xy].x;
  const float2 ab = srcB[gid.xy];
  const float q = saturate(ab.x * I + ab.y);
  const uint value = uint(q * 255.0 + 0.5);
  const uint index = gid.y * workW + gid.x;
  // Pack four mask bytes per 32-bit store via read-modify-write-free layout:
  // each thread owns one byte; store with per-byte atomics would serialize,
  // so pack in groups of 4 by the x%4==0 thread instead.
  if ((gid.x & 3u) == 0u) {
    uint packed = value;
    [unroll]
    for (uint i = 1; i < 4; i++) {
      const uint x = gid.x + i;
      uint v = 0;
      if (x < workW) {
        const float Ii = srcA[uint2(x, gid.y)].x;
        const float2 abi = srcB[uint2(x, gid.y)];
        v = uint(saturate(abi.x * Ii + abi.y) * 255.0 + 0.5);
      }
      packed |= v << (8u * i);
    }
    outBytes.Store((gid.y * ((workW + 3u) & ~3u) + gid.x), packed);
  }
}
)HLSL";

struct GuidedContext {
  bool initialized = false;
  bool available = false;
  ComPtr<ID3D11ComputeShader> csBuildIp;
  ComPtr<ID3D11ComputeShader> csBuildCorr;
  ComPtr<ID3D11ComputeShader> csBoxBlur;
  ComPtr<ID3D11ComputeShader> csBuildAb;
  ComPtr<ID3D11ComputeShader> csBlendAb;
  ComPtr<ID3D11ComputeShader> csBuildOutput;
  ComPtr<ID3D11Buffer> uniforms;
  // Work-grid float2 planes: A holds (I,p) for the whole pass chain.
  struct Plane {
    ComPtr<ID3D11Texture2D> tex;
    ComPtr<ID3D11ShaderResourceView> srv;
    ComPtr<ID3D11UnorderedAccessView> uav;
  };
  Plane planeA;
  Plane planeT1;
  Plane planeT2;
  Plane planeT3;
  Plane planePrevAb;
  uint32_t planeW = 0;
  uint32_t planeH = 0;
  LayerTexture guide;
  LayerTexture maskIn;
  ComPtr<ID3D11Buffer> outBuffer;
  ComPtr<ID3D11UnorderedAccessView> outUav;
  std::vector<ComPtr<ID3D11Buffer>> outStaging;
  StagingReadbackRing outRing;
  size_t outSize = 0;
  int radius = 8;
  float epsilon = 1.0e-3f;
  float coeffEma = 0.5f;
  bool hasPrevAb = false;
};

GuidedContext &guidedContext() {
  static GuidedContext ctx;
  return ctx;
}

double guidedEnvDouble(const char *name, double fallback) {
  const char *raw = std::getenv(name);
  if (raw == nullptr || raw[0] == '\0') return fallback;
  char *end = nullptr;
  const double value = std::strtod(raw, &end);
  if (end == raw || value <= 0.0) return fallback;
  return value;
}

bool compileGuidedShader(ID3D11Device *device, const char *entry,
                         ComPtr<ID3D11ComputeShader> *out) {
  ComPtr<ID3DBlob> blob;
  ComPtr<ID3DBlob> errors;
  HRESULT hr = D3DCompile(kGuidedShaderSource, std::strlen(kGuidedShaderSource),
                          "guided_refine", nullptr, nullptr, entry, "cs_5_0",
                          D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &blob, &errors);
  if (FAILED(hr)) {
    const std::string detail =
        errors ? std::string(static_cast<const char *>(errors->GetBufferPointer()),
                             errors->GetBufferSize())
               : hresultDetail(hr);
    logCompositorEvent("guided_shader_compile_failed",
                       std::string(entry) + ": " + detail.substr(0, 260));
    return false;
  }
  hr = device->CreateComputeShader(blob->GetBufferPointer(),
                                   blob->GetBufferSize(), nullptr,
                                   out->GetAddressOf());
  if (FAILED(hr)) {
    logCompositorEvent("guided_pipeline_failed", hresultDetail(hr));
    return false;
  }
  return true;
}

bool initializeGuidedContext() {
  GuidedContext &ctx = guidedContext();
  if (ctx.initialized) {
    return ctx.available;
  }
  ctx.initialized = true;

  // Default ON: the GPU guided edge-refine is the Windows production path.
  // Kill-switch: BROADIFY_MEETING_GPU_GUIDED=0 falls back to the CPU guided filter.
  const char *envToggle = std::getenv("BROADIFY_MEETING_GPU_GUIDED");
  if (envToggle != nullptr && std::strcmp(envToggle, "0") == 0) {
    logCompositorEvent("guided_disabled",
                       "BROADIFY_MEETING_GPU_GUIDED=0 (CPU guided)");
    return false;
  }
  if (!initializeContext()) {
    logCompositorEvent("guided_unavailable", "no D3D11 compositor context");
    return false;
  }
  D3D11Context &base = context();

  if (!compileGuidedShader(base.device.Get(), "buildIp", &ctx.csBuildIp) ||
      !compileGuidedShader(base.device.Get(), "buildCorr", &ctx.csBuildCorr) ||
      !compileGuidedShader(base.device.Get(), "boxBlur", &ctx.csBoxBlur) ||
      !compileGuidedShader(base.device.Get(), "buildAb", &ctx.csBuildAb) ||
      !compileGuidedShader(base.device.Get(), "blendAb", &ctx.csBlendAb) ||
      !compileGuidedShader(base.device.Get(), "buildOutput", &ctx.csBuildOutput)) {
    return false;
  }

  D3D11_BUFFER_DESC uniformDesc{};
  uniformDesc.ByteWidth = (sizeof(GuidedUniforms) + 15u) & ~15u;
  uniformDesc.Usage = D3D11_USAGE_DEFAULT;
  uniformDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  if (FAILED(base.device->CreateBuffer(&uniformDesc, nullptr, &ctx.uniforms))) {
    logCompositorEvent("guided_uniforms_failed", "");
    return false;
  }

  ctx.radius = std::max(
      1, static_cast<int>(guidedEnvDouble("BROADIFY_MEETING_GUIDED_RADIUS", 4.0) + 0.5));
  // Apple-parity defaults: radius 4 + epsilon 5e-4. Env-overridable for tuning.
  ctx.epsilon = static_cast<float>(
      guidedEnvDouble("BROADIFY_MEETING_GUIDED_EPSILON", 5.0e-4));
  ctx.coeffEma = static_cast<float>(
      std::clamp(guidedEnvDouble("BROADIFY_MEETING_GUIDED_COEFF_EMA", 0.0),
                 0.0, 1.0));

  ctx.available = true;
  logCompositorEvent("guided_enabled",
                     "radius " + std::to_string(ctx.radius));
  return true;
}

bool ensureGuidedPlane(GuidedContext::Plane &plane, uint32_t width,
                       uint32_t height) {
  if (plane.tex) {
    return true;
  }
  D3D11Context &base = context();
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_R32G32_FLOAT;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS;
  if (FAILED(base.device->CreateTexture2D(&desc, nullptr, &plane.tex))) {
    return false;
  }
  if (FAILED(base.device->CreateShaderResourceView(plane.tex.Get(), nullptr,
                                                   &plane.srv)) ||
      FAILED(base.device->CreateUnorderedAccessView(plane.tex.Get(), nullptr,
                                                    &plane.uav))) {
    plane.tex.Reset();
    return false;
  }
  return true;
}

bool ensureGuidedResources(uint32_t workW, uint32_t workH) {
  GuidedContext &ctx = guidedContext();
  D3D11Context &base = context();
  if (ctx.planeW != workW || ctx.planeH != workH) {
    ctx.planeA = {};
    ctx.planeT1 = {};
    ctx.planeT2 = {};
    ctx.planeT3 = {};
    ctx.planePrevAb = {};
    ctx.outBuffer.Reset();
    ctx.outUav.Reset();
    ctx.outStaging.clear();
    ctx.outRing.reset();
    ctx.outSize = 0;
    ctx.hasPrevAb = false;
    ctx.planeW = workW;
    ctx.planeH = workH;
  }
  if (!ensureGuidedPlane(ctx.planeA, workW, workH) ||
      !ensureGuidedPlane(ctx.planeT1, workW, workH) ||
      !ensureGuidedPlane(ctx.planeT2, workW, workH) ||
      !ensureGuidedPlane(ctx.planeT3, workW, workH) ||
      !ensureGuidedPlane(ctx.planePrevAb, workW, workH)) {
    return false;
  }
  const size_t strideW = (static_cast<size_t>(workW) + 3u) & ~static_cast<size_t>(3u);
  const size_t needed = strideW * workH;
  if (!ctx.outBuffer || ctx.outSize != needed) {
    ctx.outBuffer.Reset();
    ctx.outUav.Reset();
    ctx.outStaging.clear();
    ctx.outRing.reset();
    D3D11_BUFFER_DESC bufferDesc{};
    bufferDesc.ByteWidth = static_cast<UINT>(needed);
    bufferDesc.Usage = D3D11_USAGE_DEFAULT;
    bufferDesc.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
    bufferDesc.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
    if (FAILED(base.device->CreateBuffer(&bufferDesc, nullptr, &ctx.outBuffer))) {
      return false;
    }
    D3D11_UNORDERED_ACCESS_VIEW_DESC uavDesc{};
    uavDesc.Format = DXGI_FORMAT_R32_TYPELESS;
    uavDesc.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
    uavDesc.Buffer.NumElements = static_cast<UINT>(needed / 4u);
    uavDesc.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
    if (FAILED(base.device->CreateUnorderedAccessView(ctx.outBuffer.Get(),
                                                      &uavDesc, &ctx.outUav))) {
      return false;
    }
    ctx.outStaging.resize(ctx.outRing.depth());
    for (auto &stagingBuffer : ctx.outStaging) {
      D3D11_BUFFER_DESC stagingDesc{};
      stagingDesc.ByteWidth = static_cast<UINT>(needed);
      stagingDesc.Usage = D3D11_USAGE_STAGING;
      stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      if (FAILED(base.device->CreateBuffer(&stagingDesc, nullptr, &stagingBuffer))) {
        ctx.outStaging.clear();
        return false;
      }
    }
    ctx.outSize = needed;
  }
  return true;
}

// One compute pass on the work grid. srcA/srcB may be null.
void guidedDispatch(ID3D11ComputeShader *shader,
                    ID3D11ShaderResourceView *guide,
                    ID3D11ShaderResourceView *mask,
                    ID3D11ShaderResourceView *srcA,
                    ID3D11ShaderResourceView *srcB,
                    ID3D11UnorderedAccessView *outRg,
                    ID3D11UnorderedAccessView *outBytes, uint32_t workW,
                    uint32_t workH) {
  D3D11Context &base = context();
  ID3D11ShaderResourceView *srvs[4] = {guide, mask, srcA, srcB};
  ID3D11UnorderedAccessView *uavs[2] = {outRg, outBytes};
  base.context->CSSetShader(shader, nullptr, 0);
  base.context->CSSetShaderResources(0, 4, srvs);
  base.context->CSSetUnorderedAccessViews(0, 2, uavs, nullptr);
  base.context->Dispatch((workW + 7u) / 8u, (workH + 7u) / 8u, 1u);
  ID3D11ShaderResourceView *nullSrvs[4] = {};
  ID3D11UnorderedAccessView *nullUavs[2] = {};
  base.context->CSSetShaderResources(0, 4, nullSrvs);
  base.context->CSSetUnorderedAccessViews(0, 2, nullUavs, nullptr);
}

void setGuidedUniforms(uint32_t workW, uint32_t workH, uint32_t horizontal) {
  GuidedContext &ctx = guidedContext();
  D3D11Context &base = context();
  GuidedUniforms uniforms{};
  uniforms.workW = workW;
  uniforms.workH = workH;
  uniforms.radius = static_cast<uint32_t>(ctx.radius);
  uniforms.horizontal = horizontal;
  uniforms.epsilon = ctx.epsilon;
  uniforms.coeffEma = ctx.coeffEma;
  base.context->UpdateSubresource(ctx.uniforms.Get(), 0, nullptr, &uniforms, 0, 0);
  ID3D11Buffer *cbs[1] = {ctx.uniforms.Get()};
  base.context->CSSetConstantBuffers(0, 1, cbs);
  ID3D11SamplerState *samplers[1] = {base.sampler.Get()};
  base.context->CSSetSamplers(0, 1, samplers);
}

// Blurs `src` into `dst` via `tmp` (horizontal then vertical pass).
void guidedBlur(const GuidedContext::Plane &src, GuidedContext::Plane &tmp,
                GuidedContext::Plane &dst, uint32_t workW, uint32_t workH) {
  GuidedContext &ctx = guidedContext();
  setGuidedUniforms(workW, workH, 1u);
  guidedDispatch(ctx.csBoxBlur.Get(), nullptr, nullptr, src.srv.Get(), nullptr,
                 tmp.uav.Get(), nullptr, workW, workH);
  setGuidedUniforms(workW, workH, 0u);
  guidedDispatch(ctx.csBoxBlur.Get(), nullptr, nullptr, tmp.srv.Get(), nullptr,
                 dst.uav.Get(), nullptr, workW, workH);
}

}  // namespace

bool d3d11GuidedRefineAvailable() {
  return initializeGuidedContext();
}

void resetGuidedRefineD3D11History() {
  guidedContext().hasPrevAb = false;
}

bool guidedRefineMaskD3D11(AlphaMask &mask, const VideoFrame &guideFrame) {
  if (!initializeGuidedContext()) {
    return false;
  }
  if (mask.alpha.empty() || mask.width == 0u || mask.height == 0u ||
      guideFrame.rgba.empty() || guideFrame.width == 0u ||
      guideFrame.height == 0u) {
    return false;
  }
  GuidedContext &ctx = guidedContext();
  D3D11Context &base = context();

  const GuidedWorkSize workSize = selectGuidedWorkSize(
      guideFrame.width, guideFrame.height, guidedWorkWidthFromEnv());
  const uint32_t workW = workSize.width;
  const uint32_t workH = workSize.height;
  if (!ensureGuidedResources(workW, workH)) {
    logCompositorEvent("guided_alloc_failed", "");
    return false;
  }

  if (!uploadCameraFrame(&guideFrame)) {
    return false;
  }
  if (!uploadLayer(ctx.maskIn, mask.alpha.data(), mask.width, mask.height,
                   mask.timestampNs, DXGI_FORMAT_R8_UNORM, 1u)) {
    return false;
  }

  setGuidedUniforms(workW, workH, 0u);
  // A = (I, p)
  guidedDispatch(ctx.csBuildIp.Get(), base.camera.srv.Get(), ctx.maskIn.srv.Get(),
                 nullptr, nullptr, ctx.planeA.uav.Get(), nullptr, workW, workH);
  // T2 = mean(I, p)
  guidedBlur(ctx.planeA, ctx.planeT1, ctx.planeT2, workW, workH);
  // T1 = (I*I, I*p)
  setGuidedUniforms(workW, workH, 0u);
  guidedDispatch(ctx.csBuildCorr.Get(), nullptr, nullptr, ctx.planeA.srv.Get(),
                 nullptr, ctx.planeT1.uav.Get(), nullptr, workW, workH);
  // T3 = mean(I*I, I*p)  (via T1 -> blur into T3 using T1 as src, tmp = T3?)
  guidedBlur(ctx.planeT1, ctx.planeT3, ctx.planeT1, workW, workH);
  // T3 = (a, b) from means (T2) + corr means (T1)
  setGuidedUniforms(workW, workH, 0u);
  guidedDispatch(ctx.csBuildAb.Get(), nullptr, nullptr, ctx.planeT2.srv.Get(),
                 ctx.planeT1.srv.Get(), ctx.planeT3.uav.Get(), nullptr, workW,
                 workH);
  const bool coeffEmaEnabled = ctx.coeffEma > 0.0f && ctx.coeffEma < 1.0f;
  const bool useCoeffEma = coeffEmaEnabled && ctx.hasPrevAb;
  if (useCoeffEma) {
    guidedDispatch(ctx.csBlendAb.Get(), nullptr, nullptr, ctx.planeT3.srv.Get(),
                   ctx.planePrevAb.srv.Get(), ctx.planeT2.uav.Get(), nullptr,
                   workW, workH);
    base.context->CopyResource(ctx.planePrevAb.tex.Get(), ctx.planeT2.tex.Get());
    // T2 now carries the EMA'd coefficient plane for the blur below.
  } else if (coeffEmaEnabled) {
    base.context->CopyResource(ctx.planePrevAb.tex.Get(), ctx.planeT3.tex.Get());
    ctx.hasPrevAb = true;
  } else {
    ctx.hasPrevAb = false;
  }
  // T2 = mean(a, b)
  guidedBlur(useCoeffEma ? ctx.planeT2 : ctx.planeT3, ctx.planeT1,
             ctx.planeT2, workW, workH);
  // bytes = q = a*I + b
  setGuidedUniforms(workW, workH, 0u);
  guidedDispatch(ctx.csBuildOutput.Get(), nullptr, nullptr,
                 ctx.planeA.srv.Get(), ctx.planeT2.srv.Get(), nullptr,
                 ctx.outUav.Get(), workW, workH);

  D3D11Context &baseCtx = base;
  D3D11_MAPPED_SUBRESOURCE mapped{};
  size_t mappedIndex = 0;
  if (!mapCurrentFrameReadback(baseCtx.context.Get(), ctx.outStaging, ctx.outRing,
                               ctx.outBuffer.Get(), &mapped, &mappedIndex)) {
    logCompositorEvent("guided_readback_failed", "current frame map failed");
    return false;
  }
  const size_t strideW = (static_cast<size_t>(workW) + 3u) & ~static_cast<size_t>(3u);
  std::vector<uint8_t> refined(static_cast<size_t>(workW) * workH);
  const uint8_t *src = static_cast<const uint8_t *>(mapped.pData);
  for (uint32_t y = 0; y < workH; ++y) {
    std::memcpy(refined.data() + static_cast<size_t>(y) * workW,
                src + static_cast<size_t>(y) * strideW, workW);
  }
  baseCtx.context->Unmap(ctx.outStaging[mappedIndex].Get(), 0);

  mask.width = workW;
  mask.height = workH;
  mask.alpha = std::move(refined);
  return true;
}

std::string d3d11CompositorAdapterStatus() {
  return d3dAdapterStatusString(sharedD3DAdapter());
}

}  // namespace broadify::meeting
