#include "compose/metal_compositor.h"
#include "compose/metal_device.h"
#include "compose/gpu_compositor_uniforms.h"

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <cstdlib>
#include <cstring>
#include <iostream>

namespace broadify::meeting {
namespace {

constexpr const char *kComposeShaderSource = R"MSL(
#include <metal_stdlib>
using namespace metal;

struct ComposeUniforms {
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


constexpr sampler kLayerSampler(filter::linear, address::clamp_to_edge, coord::normalized);

static float4 sampleLayer(texture2d<float> layer, float2 sourcePx) {
  const float2 dims = float2(layer.get_width(), layer.get_height());
  const float2 uv = (sourcePx + 0.5) / dims;
  return layer.sample(kLayerSampler, uv);
}

static float3 blendUnorm8(float3 destination, float3 source, float alpha) {
  const float3 blended = mix(destination, source, alpha);
  return floor(clamp(blended, 0.0, 1.0) * 255.0 + 1.0e-4) / 255.0;
}

kernel void composeProgram(device uchar4 *output [[buffer(0)]],
                           constant ComposeUniforms &u [[buffer(1)]],
                           texture2d<float> cameraTex [[texture(0)]],
                           texture2d<float> backTex [[texture(1)]],
                           texture2d<float> frontTex [[texture(2)]],
                           texture2d<float> maskTex [[texture(3)]],
                           texture2d<float> bgImageTex [[texture(4)]],
                           uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= u.width || gid.y >= u.height) {
    return;
  }

  const float2 dest = float2(gid) + 0.5;
  float3 rgb;

  // Background (matches fillBackground on the CPU path).
  switch (u.backgroundMode) {
    case 1: {  // animated gradient
      const uint wave = (gid.x + gid.y + u.frameIndex96) % 96u;
      const float r = clamp(20.0 + floor((120.0 * float(gid.x)) / float(max(u.width, 1u))) + float(wave / 5u), 0.0, 255.0);
      const float g = clamp(54.0 + floor((90.0 * float(gid.y)) / float(max(u.height, 1u))), 0.0, 255.0);
      const float b = clamp(94.0 + float(wave), 0.0, 255.0);
      rgb = float3(r, g, b) / 255.0;
      break;
    }
    case 2:
      rgb = float3(232.0, 236.0, 229.0) / 255.0;
      break;
    case 3: {
      const bool tile = ((gid.x / 48u) + (gid.y / 48u)) % 2u == 0u;
      rgb = (tile ? float3(42.0, 45.0, 50.0) : float3(70.0, 74.0, 82.0)) / 255.0;
      break;
    }
    case 4:
      rgb = float3(0.0);
      break;
    default:
      rgb = float3(8.0, 10.0, 14.0) / 255.0;
      break;
  }

  // Uploaded company background image (cover-cropped, below all layers).
  if (u.bgImagePresent != 0u) {
    float2 src = float2(dest.x * u.bgImgScaleX + u.bgImgBiasX, dest.y * u.bgImgScaleY + u.bgImgBiasY);
    const float4 s = sampleLayer(bgImageTex, src);
    rgb = blendUnorm8(rgb, s.rgb, s.a);
  }

  // Back graphics (cover-cropped full-frame layer).
  if (u.backPresent != 0u) {
    float2 src = float2(dest.x * u.backScaleX + u.backBiasX, dest.y * u.backScaleY + u.backBiasY);
    const float4 s = sampleLayer(backTex, src);
    rgb = blendUnorm8(rgb, s.rgb, s.a);
  }

  // Camera layer: keyed presenter (transform anchored to the keyed bottom
  // edge) or full-frame cover camera.
  if (u.cameraPresent != 0u) {
    float2 src = float2(dest.x * u.camScaleX + u.camBiasX, dest.y * u.camScaleY + u.camBiasY);
    if (u.cameraMirror != 0u) {
      src.x = u.camMirrorConst - src.x;
    }
    if (src.x >= 0.0 && src.x <= u.camTexWidth - 1.0 && src.y >= 0.0 && src.y <= u.camTexHeight - 1.0) {
      const float4 s = sampleLayer(cameraTex, src);
      float alpha = s.a;
      if (u.cameraKeyed != 0u) {
        alpha = 0.0;
        if (u.maskPresent != 0u) {
          const float2 uv = (src + 0.5) / float2(u.camTexWidth, u.camTexHeight);
          const float raw = maskTex.sample(kLayerSampler, uv).r * 255.0;
          if (raw > 18.0) {
            alpha = raw >= 242.0
                ? 1.0
                : smoothstep(0.0, 1.0, (raw - 18.0) / 224.0);
          }
          if (alpha <= 8.0 / 255.0) {
            alpha = 0.0;
          }
        }
      }
      rgb = blendUnorm8(rgb, s.rgb, alpha);
    }
  }

  // Front graphics.
  if (u.frontPresent != 0u) {
    float2 src = float2(dest.x * u.frontScaleX + u.frontBiasX, dest.y * u.frontScaleY + u.frontBiasY);
    const float4 s = sampleLayer(frontTex, src);
    rgb = blendUnorm8(rgb, s.rgb, s.a);
  }

  const uint index = gid.y * u.width + gid.x;
  const float3 scaled = clamp(rgb, 0.0, 1.0) * 255.0 + 0.5;
  output[index] = uchar4(uchar(scaled.r), uchar(scaled.g), uchar(scaled.b), 255);
}
)MSL";

struct LayerTexture {
  id<MTLTexture> texture = nil;
  uint64_t timestampNs = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

struct MetalContext {
  bool initialized = false;
  bool available = false;
  id<MTLDevice> device = nil;
  id<MTLCommandQueue> queue = nil;
  id<MTLComputePipelineState> pipeline = nil;
  id<MTLBuffer> outputBuffer = nil;
  size_t outputBufferSize = 0;
  LayerTexture camera;
  LayerTexture back;
  LayerTexture front;
  LayerTexture mask;
  LayerTexture backgroundImage;
};

// The program loop is the only caller, so no locking is needed.
MetalContext &context() {
  static MetalContext ctx;
  return ctx;
}

void logCompositorEvent(const char *event, const std::string &detail) {
  std::cout << "{\"type\":\"meeting_gpu_compositor\",\"event\":\"" << event
            << "\",\"detail\":\"" << detail << "\"}" << std::endl;
}

bool initializeContext() {
  MetalContext &ctx = context();
  if (ctx.initialized) {
    return ctx.available;
  }
  ctx.initialized = true;

  const char *envToggle = std::getenv("BROADIFY_MEETING_GPU_COMPOSITOR");
  if (envToggle != nullptr && std::strcmp(envToggle, "0") == 0) {
    logCompositorEvent("disabled", "env BROADIFY_MEETING_GPU_COMPOSITOR=0");
    return false;
  }

  @autoreleasepool {
    id<MTLDevice> device = sharedMetalDevice();
    if (device == nil) {
      logCompositorEvent("unavailable", "no Metal device");
      return false;
    }
    NSError *error = nil;
    id<MTLLibrary> library =
        [device newLibraryWithSource:[NSString stringWithUTF8String:kComposeShaderSource]
                             options:nil
                               error:&error];
    if (library == nil) {
      logCompositorEvent("shader_compile_failed",
                         error != nil ? error.localizedDescription.UTF8String : "unknown");
      return false;
    }
    id<MTLFunction> function = [library newFunctionWithName:@"composeProgram"];
    if (function == nil) {
      logCompositorEvent("shader_missing_function", "composeProgram");
      return false;
    }
    id<MTLComputePipelineState> pipeline =
        [device newComputePipelineStateWithFunction:function error:&error];
    if (pipeline == nil) {
      logCompositorEvent("pipeline_failed",
                         error != nil ? error.localizedDescription.UTF8String : "unknown");
      return false;
    }
    ctx.device = device;
    ctx.queue = sharedMetalQueue();
    ctx.pipeline = pipeline;
    ctx.available = ctx.queue != nil;
    if (ctx.available) {
      logCompositorEvent("enabled", device.name.UTF8String);
    }
    return ctx.available;
  }
}

// Uploads the frame into the cached slot texture; skips the copy when the
// timestamp is unchanged (graphics layers repeat frames between updates).
bool uploadLayer(LayerTexture &slot, const VideoFrame *frame) {
  if (frame == nullptr || frame->rgba.empty() || frame->width == 0u || frame->height == 0u) {
    return false;
  }
  MetalContext &ctx = context();
  if (slot.texture == nil || slot.width != frame->width || slot.height != frame->height) {
    MTLTextureDescriptor *descriptor =
        [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                           width:frame->width
                                                          height:frame->height
                                                       mipmapped:NO];
    descriptor.usage = MTLTextureUsageShaderRead;
    descriptor.storageMode = MTLStorageModeManaged;
    slot.texture = [ctx.device newTextureWithDescriptor:descriptor];
    slot.width = frame->width;
    slot.height = frame->height;
    slot.timestampNs = 0;
    if (slot.texture == nil) {
      return false;
    }
  }
  if (frame->timestampNs == 0u || frame->timestampNs != slot.timestampNs) {
    [slot.texture replaceRegion:MTLRegionMake2D(0, 0, frame->width, frame->height)
                    mipmapLevel:0
                      withBytes:frame->rgba.data()
                    bytesPerRow:static_cast<NSUInteger>(frame->width) * 4u];
    slot.timestampNs = frame->timestampNs;
  }
  return true;
}

}  // namespace

bool metalCompositorAvailable() {
  return initializeContext();
}

bool renderProgramFrameMetal(const GpuComposePlan &plan, std::vector<uint8_t> &output) {
  if (!initializeContext() || plan.width == 0u || plan.height == 0u) {
    return false;
  }

  MetalContext &ctx = context();
  @autoreleasepool {
    GpuComposeUniforms uniforms{};
    uniforms.width = plan.width;
    uniforms.height = plan.height;
    uniforms.backgroundMode = static_cast<uint32_t>(plan.backgroundMode);
    uniforms.frameIndex96 = static_cast<uint32_t>(plan.frameIndex % 96u);

    if (plan.camera.present && !uploadLayer(ctx.camera, plan.cameraFrame)) {
      return false;
    }
    if (plan.camera.present) {
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
    if (plan.backMapping.present && !uploadLayer(ctx.back, plan.backGraphics)) {
      return false;
    }
    if (plan.backMapping.present) {
      uniforms.backPresent = 1u;
      uniforms.backScaleX = plan.backMapping.scaleX;
      uniforms.backScaleY = plan.backMapping.scaleY;
      uniforms.backBiasX = plan.backMapping.biasX;
      uniforms.backBiasY = plan.backMapping.biasY;
    }
    if (plan.frontMapping.present && !uploadLayer(ctx.front, plan.frontGraphics)) {
      return false;
    }
    if (plan.frontMapping.present) {
      uniforms.frontPresent = 1u;
      uniforms.frontScaleX = plan.frontMapping.scaleX;
      uniforms.frontScaleY = plan.frontMapping.scaleY;
      uniforms.frontBiasX = plan.frontMapping.biasX;
      uniforms.frontBiasY = plan.frontMapping.biasY;
    }

    // Uploaded company background image (cover-fitted below all layers). The
    // cache key skips re-uploads while the same image stays selected.
    if (plan.backgroundImage != nullptr && plan.backgroundImageWidth > 0u &&
        plan.backgroundImageHeight > 0u) {
      VideoFrame bgFrame;
      bgFrame.width = plan.backgroundImageWidth;
      bgFrame.height = plan.backgroundImageHeight;
      bgFrame.timestampNs = plan.backgroundImageCacheKey;
      bgFrame.rgba.assign(
          plan.backgroundImage,
          plan.backgroundImage +
              static_cast<size_t>(plan.backgroundImageWidth) *
                  plan.backgroundImageHeight * 4u);
      if (uploadLayer(ctx.backgroundImage, &bgFrame)) {
        uniforms.bgImagePresent = 1u;
        uniforms.bgImgScaleX = plan.backgroundImageMapping.scaleX;
        uniforms.bgImgScaleY = plan.backgroundImageMapping.scaleY;
        uniforms.bgImgBiasX = plan.backgroundImageMapping.biasX;
        uniforms.bgImgBiasY = plan.backgroundImageMapping.biasY;
      }
    }

    // Upload the CPU R8 mask into the cached slot.
    id<MTLTexture> maskTexture = nil;
    if (plan.camera.keyed && plan.cameraMask != nullptr && plan.maskWidth > 0u && plan.maskHeight > 0u) {
      LayerTexture &slot = ctx.mask;
      if (slot.texture == nil || slot.width != plan.maskWidth || slot.height != plan.maskHeight) {
        MTLTextureDescriptor *descriptor =
            [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR8Unorm
                                                               width:plan.maskWidth
                                                              height:plan.maskHeight
                                                           mipmapped:NO];
        descriptor.usage = MTLTextureUsageShaderRead;
        descriptor.storageMode = MTLStorageModeManaged;
        slot.texture = [ctx.device newTextureWithDescriptor:descriptor];
        slot.width = plan.maskWidth;
        slot.height = plan.maskHeight;
        slot.timestampNs = 0;
      }
      if (slot.texture == nil) {
        return false;
      }
      if (plan.maskTimestampNs == 0u || plan.maskTimestampNs != slot.timestampNs) {
        [slot.texture replaceRegion:MTLRegionMake2D(0, 0, plan.maskWidth, plan.maskHeight)
                        mipmapLevel:0
                          withBytes:plan.cameraMask
                        bytesPerRow:plan.maskWidth];
        slot.timestampNs = plan.maskTimestampNs;
      }
      maskTexture = slot.texture;
      uniforms.maskPresent = 1u;
    } else if (plan.camera.keyed) {
      return false;
    }

    const size_t byteCount = static_cast<size_t>(plan.width) * plan.height * 4u;
    if (ctx.outputBuffer == nil || ctx.outputBufferSize != byteCount) {
      ctx.outputBuffer = [ctx.device newBufferWithLength:byteCount
                                                 options:MTLResourceStorageModeShared];
      ctx.outputBufferSize = byteCount;
      if (ctx.outputBuffer == nil) {
        return false;
      }
    }

    id<MTLCommandBuffer> commandBuffer = [ctx.queue commandBuffer];
    id<MTLComputeCommandEncoder> encoder = [commandBuffer computeCommandEncoder];
    if (commandBuffer == nil || encoder == nil) {
      return false;
    }
    [encoder setComputePipelineState:ctx.pipeline];
    [encoder setBuffer:ctx.outputBuffer offset:0 atIndex:0];
    [encoder setBytes:&uniforms length:sizeof(uniforms) atIndex:1];
    [encoder setTexture:(uniforms.cameraPresent != 0u ? ctx.camera.texture : nil) atIndex:0];
    [encoder setTexture:(uniforms.backPresent != 0u ? ctx.back.texture : nil) atIndex:1];
    [encoder setTexture:(uniforms.frontPresent != 0u ? ctx.front.texture : nil) atIndex:2];
    [encoder setTexture:(uniforms.maskPresent != 0u ? maskTexture : nil) atIndex:3];
    [encoder setTexture:(uniforms.bgImagePresent != 0u ? ctx.backgroundImage.texture : nil) atIndex:4];

    const MTLSize threadgroupSize = MTLSizeMake(16, 16, 1);
    const MTLSize threadgroups = MTLSizeMake(
        (plan.width + threadgroupSize.width - 1) / threadgroupSize.width,
        (plan.height + threadgroupSize.height - 1) / threadgroupSize.height,
        1);
    [encoder dispatchThreadgroups:threadgroups threadsPerThreadgroup:threadgroupSize];
    [encoder endEncoding];
    [commandBuffer commit];
    [commandBuffer waitUntilCompleted];
    if (commandBuffer.status != MTLCommandBufferStatusCompleted) {
      logCompositorEvent("render_failed", "command buffer not completed");
      return false;
    }

    output.resize(byteCount);
    std::memcpy(output.data(), ctx.outputBuffer.contents, byteCount);
    return true;
  }
}

}  // namespace broadify::meeting
