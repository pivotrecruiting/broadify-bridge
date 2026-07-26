#include "compose/metal_compositor.h"
#include "compose/metal_device.h"

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <cstdlib>
#include <cstring>
#include <iostream>

namespace broadify::meeting {
namespace {

// Must match the MSL struct layout below (16-byte aligned rows of 4).
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


constexpr sampler kLayerSampler(filter::linear, address::clamp_to_edge, coord::normalized);

static float4 sampleLayer(texture2d<float> layer, float2 sourcePx) {
  const float2 dims = float2(layer.get_width(), layer.get_height());
  const float2 uv = (sourcePx + 0.5) / dims;
  return layer.sample(kLayerSampler, uv);
}

// Media (PiP) layer: inverse-homography lookup into the fitted image quad,
// preceded by the optional planar drop shadow quad.
static float3 blendMedia(float3 rgb, constant ComposeUniforms &u, texture2d<float> mediaTex, float2 dest) {
  if (u.shadowPresent != 0u) {
    const float sw = u.s20 * dest.x + u.s21 * dest.y + u.s22;
    if (fabs(sw) > 1e-9) {
      const float su = (u.s00 * dest.x + u.s01 * dest.y + u.s02) / sw;
      const float sv = (u.s10 * dest.x + u.s11 * dest.y + u.s12) / sw;
      if (su >= 0.0 && su <= 1.0 && sv >= 0.0 && sv <= 1.0) {
        rgb = mix(rgb, float3(0.0), 46.0 / 255.0);
      }
    }
  }
  const float w = u.m20 * dest.x + u.m21 * dest.y + u.m22;
  if (fabs(w) < 1e-9) {
    return rgb;
  }
  const float mu = (u.m00 * dest.x + u.m01 * dest.y + u.m02) / w;
  const float mv = (u.m10 * dest.x + u.m11 * dest.y + u.m12) / w;
  if (mu < 0.0 || mu > 1.0 || mv < 0.0 || mv > 1.0) {
    return rgb;
  }
  const float2 dims = float2(mediaTex.get_width(), mediaTex.get_height());
  const float4 s = sampleLayer(mediaTex, float2(mu, mv) * dims - 0.5);
  const float a = s.a;
  const float3 c = a > 0.001 ? min(s.rgb / a, 1.0) : float3(0.0);
  return mix(rgb, c, a);
}

kernel void composeProgram(device uchar4 *output [[buffer(0)]],
                           constant ComposeUniforms &u [[buffer(1)]],
                           texture2d<float> cameraTex [[texture(0)]],
                           texture2d<float> backTex [[texture(1)]],
                           texture2d<float> frontTex [[texture(2)]],
                           texture2d<float> mediaTex [[texture(3)]],
                           texture2d<float> maskTex [[texture(4)]],
                           texture2d<float> bgImageTex [[texture(5)]],
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
      const float r = clamp(20.0 + (120.0 * float(gid.x)) / float(max(u.width, 1u)) + float(wave / 5u), 0.0, 255.0);
      const float g = clamp(54.0 + (90.0 * float(gid.y)) / float(max(u.height, 1u)), 0.0, 255.0);
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
    rgb = mix(rgb, s.rgb, s.a);
  }

  // Back graphics (cover-cropped full-frame layer).
  if (u.backPresent != 0u) {
    float2 src = float2(dest.x * u.backScaleX + u.backBiasX, dest.y * u.backScaleY + u.backBiasY);
    const float4 s = sampleLayer(backTex, src);
    rgb = mix(rgb, s.rgb, s.a);
  }

  if (u.mediaPresent != 0u && u.mediaBelowCamera != 0u) {
    rgb = blendMedia(rgb, u, mediaTex, dest);
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
        // Keyer mask (stretched over the camera frame) + the same normalize
        // curve as the previous CPU alpha pass (cutoffs 18/242, smoothstep).
        alpha = 0.0;
        if (u.maskPresent != 0u) {
          const float2 uv = (src + 0.5) / float2(u.camTexWidth, u.camTexHeight);
          const float raw = maskTex.sample(kLayerSampler, uv).r * 255.0;
          if (raw > 18.0) {
            alpha = raw >= 242.0 ? 1.0 : smoothstep(0.0, 1.0, (raw - 18.0) / 224.0);
          }
          // Only clip truly negligible alpha; keep the soft hair/edge band that
          // the old 24.5/255 snap discarded.
          if (alpha <= 8.0 / 255.0) {
            alpha = 0.0;
          }
        }
      }
      rgb = mix(rgb, s.rgb, alpha);
    }
  }

  if (u.mediaPresent != 0u && u.mediaBelowCamera == 0u) {
    rgb = blendMedia(rgb, u, mediaTex, dest);
  }

  // Front graphics.
  if (u.frontPresent != 0u) {
    float2 src = float2(dest.x * u.frontScaleX + u.frontBiasX, dest.y * u.frontScaleY + u.frontBiasY);
    const float4 s = sampleLayer(frontTex, src);
    rgb = mix(rgb, s.rgb, s.a);
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
  LayerTexture media;
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

bool renderProgramFrameMetal(const MetalComposePlan &plan, std::vector<uint8_t> &output) {
  if (!initializeContext() || plan.width == 0u || plan.height == 0u) {
    return false;
  }

  MetalContext &ctx = context();
  @autoreleasepool {
    ComposeUniforms uniforms{};
    uniforms.width = plan.width;
    uniforms.height = plan.height;
    uniforms.backgroundMode = static_cast<uint32_t>(plan.backgroundMode);
    uniforms.frameIndex96 = static_cast<uint32_t>(plan.frameIndex % 96u);

    if (plan.camera.present && uploadLayer(ctx.camera, plan.cameraFrame)) {
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
    if (plan.backMapping.present && uploadLayer(ctx.back, plan.backGraphics)) {
      uniforms.backPresent = 1u;
      uniforms.backScaleX = plan.backMapping.scaleX;
      uniforms.backScaleY = plan.backMapping.scaleY;
      uniforms.backBiasX = plan.backMapping.biasX;
      uniforms.backBiasY = plan.backMapping.biasY;
    }
    if (plan.frontMapping.present && uploadLayer(ctx.front, plan.frontGraphics)) {
      uniforms.frontPresent = 1u;
      uniforms.frontScaleX = plan.frontMapping.scaleX;
      uniforms.frontScaleY = plan.frontMapping.scaleY;
      uniforms.frontBiasX = plan.frontMapping.biasX;
      uniforms.frontBiasY = plan.frontMapping.biasY;
    }

    if (plan.backgroundImage != nullptr && plan.backgroundImageWidth > 0u && plan.backgroundImageHeight > 0u) {
      VideoFrame bgFrame;
      bgFrame.width = plan.backgroundImageWidth;
      bgFrame.height = plan.backgroundImageHeight;
      bgFrame.timestampNs = plan.backgroundImageCacheKey;
      bgFrame.rgba.assign(plan.backgroundImage,
                          plan.backgroundImage + static_cast<size_t>(plan.backgroundImageWidth) * plan.backgroundImageHeight * 4u);
      if (uploadLayer(ctx.backgroundImage, &bgFrame)) {
        uniforms.bgImagePresent = 1u;
        uniforms.bgImgScaleX = plan.backgroundImageMapping.scaleX;
        uniforms.bgImgScaleY = plan.backgroundImageMapping.scaleY;
        uniforms.bgImgBiasX = plan.backgroundImageMapping.biasX;
        uniforms.bgImgBiasY = plan.backgroundImageMapping.biasY;
      }
    }

    if (plan.media.present && plan.media.rgba != nullptr && plan.media.width > 0u && plan.media.height > 0u) {
      VideoFrame mediaFrame;
      mediaFrame.width = plan.media.width;
      mediaFrame.height = plan.media.height;
      mediaFrame.timestampNs = plan.media.cacheKey;
      // Borrow the pixel data without copying; uploadLayer only reads it.
      mediaFrame.rgba.assign(plan.media.rgba, plan.media.rgba + static_cast<size_t>(plan.media.width) * plan.media.height * 4u);
      if (uploadLayer(ctx.media, &mediaFrame)) {
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
    }

    // Mask: a pre-made GPU texture (fused zero-copy path) is used directly;
    // otherwise the CPU R8 mask is uploaded into the cached slot.
    id<MTLTexture> maskTexture = nil;
    if (plan.camera.keyed && plan.maskTextureHandle != nullptr) {
      maskTexture = (__bridge id<MTLTexture>)plan.maskTextureHandle;
      uniforms.maskPresent = 1u;
    } else if (plan.camera.keyed && plan.cameraMask != nullptr && plan.maskWidth > 0u && plan.maskHeight > 0u) {
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
      if (slot.texture != nil) {
        if (plan.maskTimestampNs == 0u || plan.maskTimestampNs != slot.timestampNs) {
          [slot.texture replaceRegion:MTLRegionMake2D(0, 0, plan.maskWidth, plan.maskHeight)
                          mipmapLevel:0
                            withBytes:plan.cameraMask
                          bytesPerRow:plan.maskWidth];
          slot.timestampNs = plan.maskTimestampNs;
        }
        maskTexture = slot.texture;
        uniforms.maskPresent = 1u;
      }
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
    [encoder setTexture:(uniforms.mediaPresent != 0u ? ctx.media.texture : nil) atIndex:3];
    [encoder setTexture:(uniforms.maskPresent != 0u ? maskTexture : nil) atIndex:4];
    [encoder setTexture:(uniforms.bgImagePresent != 0u ? ctx.backgroundImage.texture : nil) atIndex:5];

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
