#include "compose/metal_device.h"

#if defined(__APPLE__)

namespace broadify::meeting {
namespace {

struct SharedMetal {
  id<MTLDevice> device = nil;
  id<MTLCommandQueue> queue = nil;
  CVMetalTextureCacheRef cache = nullptr;
};

SharedMetal &shared() {
  static SharedMetal s;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    s.device = MTLCreateSystemDefaultDevice();
    if (s.device == nil) {
      return;
    }
    s.queue = [s.device newCommandQueue];
    CVMetalTextureCacheCreate(kCFAllocatorDefault, nullptr, s.device, nullptr,
                              &s.cache);
  });
  return s;
}

}  // namespace

id<MTLDevice> sharedMetalDevice() { return shared().device; }
id<MTLCommandQueue> sharedMetalQueue() { return shared().queue; }
CVMetalTextureCacheRef sharedMetalTextureCache() { return shared().cache; }

}  // namespace broadify::meeting

#endif  // __APPLE__
