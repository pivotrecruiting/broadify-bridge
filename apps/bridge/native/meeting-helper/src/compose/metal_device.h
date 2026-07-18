#pragma once

#if defined(__APPLE__)

#import <CoreVideo/CoreVideo.h>
#import <Metal/Metal.h>

namespace broadify::meeting {

// One shared Metal device, command queue, and CoreVideo texture cache for the
// compositor and mask refiner. Sharing the device avoids duplicate Metal
// contexts and keeps both stages on the same GPU. All accessors return
// nil/nullptr when Metal is unavailable; callers fall back to the CPU path.
id<MTLDevice> sharedMetalDevice();
id<MTLCommandQueue> sharedMetalQueue();
CVMetalTextureCacheRef sharedMetalTextureCache();

}  // namespace broadify::meeting

#endif  // __APPLE__
