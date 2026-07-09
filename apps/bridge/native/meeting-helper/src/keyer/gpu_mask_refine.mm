#include "keyer/gpu_mask_refine.h"

#if defined(__APPLE__)

#include "compose/metal_device.h"

#import <Accelerate/Accelerate.h>
#import <Metal/Metal.h>
#import <MetalPerformanceShaders/MetalPerformanceShaders.h>

#include <algorithm>
#include <cstdlib>
#include <vector>

namespace broadify::meeting {
namespace {

// Guided-filter coefficients are computed at the mask's native resolution (the
// CoreML matte is 512), then joint-upsampled against a higher-res guide.
constexpr uint32_t kRegSize = 512u;

int envInt(const char *name, int fallback, int lo, int hi) {
  const char *raw = std::getenv(name);
  if (raw == nullptr || raw[0] == '\0') return fallback;
  const int v = std::atoi(raw);
  return (v >= lo && v <= hi) ? v : fallback;
}
double envDouble(const char *name, double fallback) {
  const char *raw = std::getenv(name);
  if (raw == nullptr || raw[0] == '\0') return fallback;
  char *end = nullptr;
  const double v = std::strtod(raw, &end);
  return (end != raw && v > 0.0) ? v : fallback;
}

}  // namespace

class GpuMaskRefiner::Impl {
 public:
  Impl() {
    device_ = sharedMetalDevice();
    queue_ = sharedMetalQueue();
    textureCache_ = sharedMetalTextureCache();
    if (device_ == nil || queue_ == nil || textureCache_ == nullptr) return;
    if (@available(macOS 10.13, *)) {
      const int diameter = 2 * envInt("BROADIFY_MEETING_GPU_RADIUS", 4, 1, 32) + 1;
      guided_ = [[MPSImageGuidedFilter alloc] initWithDevice:device_
                                              kernelDiameter:diameter];
      guided_.epsilon = static_cast<float>(
          envDouble("BROADIFY_MEETING_GPU_EPSILON", 1.0e-4));
      scale_ = [[MPSImageBilinearScale alloc] initWithDevice:device_];
    }
    outWidth_ = static_cast<uint32_t>(
        envInt("BROADIFY_MEETING_GPU_REFINE_WIDTH", 960, 320, 1920));
    ready_ = guided_ != nil && scale_ != nil;
  }

  // device_/queue_/textureCache_ are owned by the shared singleton; don't free.
  ~Impl() = default;

  bool available() const { return ready_; }

  // Encodes the full guided-filter refinement on the GPU (mask + camera in,
  // result left in outMask_). Returns false on any failure; outW/outH receive
  // the result size. Waits for completion so the texture is ready to use/read.
  bool encodeRefine(CVPixelBufferRef alpha, const VideoFrame &camera,
                    uint32_t &outW, uint32_t &outH) {
    if (!ready_ || alpha == nullptr || camera.rgba.empty() || camera.width == 0u ||
        camera.height == 0u) {
      return false;
    }
    outW = std::min(outWidth_, camera.width);
    outH = std::max(1u, static_cast<uint32_t>(static_cast<uint64_t>(outW) *
                                              camera.height / camera.width));

    id<MTLTexture> maskTex = wrapAlpha(alpha);  // CoreML alpha -> r16Float texture
    if (maskTex == nil) return false;
    id<MTLTexture> cameraTex = uploadCamera(camera);  // Stage 3 makes this zero-copy
    if (cameraTex == nil) return false;

    ensureTexture(guideLow_, kRegSize, kRegSize, MTLPixelFormatRGBA8Unorm,
                  MTLStorageModePrivate);
    ensureTexture(guideHigh_, outW, outH, MTLPixelFormatRGBA8Unorm,
                  MTLStorageModePrivate);
    ensureTexture(coeff_, kRegSize, kRegSize, MTLPixelFormatRGBA32Float,
                  MTLStorageModePrivate);
    ensureTexture(outMask_, outW, outH, MTLPixelFormatR16Float,
                  MTLStorageModeShared);
    if (guideLow_ == nil || guideHigh_ == nil || coeff_ == nil || outMask_ == nil) {
      return false;
    }

    if (@available(macOS 10.13, *)) {
      id<MTLCommandBuffer> cb = [queue_ commandBuffer];
      [scale_ encodeToCommandBuffer:cb sourceTexture:cameraTex destinationTexture:guideLow_];
      [scale_ encodeToCommandBuffer:cb sourceTexture:cameraTex destinationTexture:guideHigh_];
      [guided_ encodeRegressionToCommandBuffer:cb
                                 sourceTexture:maskTex
                               guidanceTexture:guideLow_
                                weightsTexture:nil
                destinationCoefficientsTexture:coeff_];
      [guided_ encodeReconstructionToCommandBuffer:cb
                                   guidanceTexture:guideHigh_
                               coefficientsTexture:coeff_
                                destinationTexture:outMask_];
      [cb commit];
      [cb waitUntilCompleted];
      return cb.status != MTLCommandBufferStatusError;
    }
    return false;
  }

  bool refine(CVPixelBufferRef alpha, const VideoFrame &camera, AlphaMask &out) {
    @autoreleasepool {
      uint32_t outW = 0, outH = 0;
      if (!encodeRefine(alpha, camera, outW, outH)) return false;
      return readback(outMask_, outW, outH, camera.timestampNs, out);
    }
  }

  void *refineToTexture(CVPixelBufferRef alpha, const VideoFrame &camera,
                        uint32_t &outWidth, uint32_t &outHeight) {
    @autoreleasepool {
      if (!encodeRefine(alpha, camera, outWidth, outHeight)) return nullptr;
      return (__bridge void *)outMask_;
    }
  }

 private:
  id<MTLTexture> wrapAlpha(CVPixelBufferRef buffer) {
    const size_t w = CVPixelBufferGetWidth(buffer);
    const size_t h = CVPixelBufferGetHeight(buffer);
    CVMetalTextureRef cvtex = nullptr;
    const CVReturn r = CVMetalTextureCacheCreateTextureFromImage(
        kCFAllocatorDefault, textureCache_, buffer, nullptr, MTLPixelFormatR16Float,
        w, h, 0, &cvtex);
    if (r != kCVReturnSuccess || cvtex == nullptr) {
      if (cvtex) CFRelease(cvtex);
      return nil;
    }
    id<MTLTexture> tex = CVMetalTextureGetTexture(cvtex);
    CFRelease(cvtex);  // texture retains its own reference
    return tex;
  }

  id<MTLTexture> uploadCamera(const VideoFrame &camera) {
    ensureTexture(cameraTex_, camera.width, camera.height, MTLPixelFormatRGBA8Unorm,
                  MTLStorageModeShared);
    if (cameraTex_ == nil) return nil;
    [cameraTex_ replaceRegion:MTLRegionMake2D(0, 0, camera.width, camera.height)
                  mipmapLevel:0
                    withBytes:camera.rgba.data()
                  bytesPerRow:static_cast<NSUInteger>(camera.width) * 4u];
    return cameraTex_;
  }

  void ensureTexture(__strong id<MTLTexture> &tex, uint32_t w, uint32_t h,
                     MTLPixelFormat fmt, MTLStorageMode storage) {
    if (tex != nil && tex.width == w && tex.height == h && tex.pixelFormat == fmt) {
      return;
    }
    MTLTextureDescriptor *d = [MTLTextureDescriptor
        texture2DDescriptorWithPixelFormat:fmt
                                     width:w
                                    height:h
                                 mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
    d.storageMode = storage;
    tex = [device_ newTextureWithDescriptor:d];
  }

  bool readback(id<MTLTexture> tex, uint32_t w, uint32_t h, uint64_t ts, AlphaMask &out) {
    halfScratch_.resize(static_cast<size_t>(w) * h);
    [tex getBytes:halfScratch_.data()
         bytesPerRow:static_cast<NSUInteger>(w) * sizeof(uint16_t)
          fromRegion:MTLRegionMake2D(0, 0, w, h)
         mipmapLevel:0];
    floatScratch_.resize(static_cast<size_t>(w) * h);
    vImage_Buffer src16{halfScratch_.data(), h, w, static_cast<size_t>(w) * sizeof(uint16_t)};
    vImage_Buffer dstF{floatScratch_.data(), h, w, static_cast<size_t>(w) * sizeof(float)};
    if (vImageConvert_Planar16FtoPlanarF(&src16, &dstF, kvImageNoFlags) != kvImageNoError) {
      return false;
    }
    out.width = w;
    out.height = h;
    out.timestampNs = ts;
    out.alpha.assign(static_cast<size_t>(w) * h, 0u);
    for (size_t i = 0, n = out.alpha.size(); i < n; ++i) {
      const float a = std::clamp(floatScratch_[i], 0.0f, 1.0f);
      out.alpha[i] = static_cast<uint8_t>(a * 255.0f + 0.5f);
    }
    return true;
  }

  id<MTLDevice> device_ = nil;
  id<MTLCommandQueue> queue_ = nil;
  CVMetalTextureCacheRef textureCache_ = nullptr;
  MPSImageGuidedFilter *guided_ = nil;
  MPSImageBilinearScale *scale_ = nil;
  id<MTLTexture> cameraTex_ = nil;
  id<MTLTexture> guideLow_ = nil;
  id<MTLTexture> guideHigh_ = nil;
  id<MTLTexture> coeff_ = nil;
  id<MTLTexture> outMask_ = nil;
  std::vector<uint16_t> halfScratch_;
  std::vector<float> floatScratch_;
  uint32_t outWidth_ = 960u;
  bool ready_ = false;
};

GpuMaskRefiner::GpuMaskRefiner() : impl_(std::make_unique<Impl>()) {}
GpuMaskRefiner::~GpuMaskRefiner() = default;
bool GpuMaskRefiner::available() const { return impl_->available(); }
bool GpuMaskRefiner::refine(CVPixelBufferRef alpha, const VideoFrame &camera, AlphaMask &out) {
  return impl_->refine(alpha, camera, out);
}
void *GpuMaskRefiner::refineToTexture(CVPixelBufferRef alpha, const VideoFrame &camera,
                                      uint32_t &outWidth, uint32_t &outHeight) {
  return impl_->refineToTexture(alpha, camera, outWidth, outHeight);
}

}  // namespace broadify::meeting

#endif  // __APPLE__
