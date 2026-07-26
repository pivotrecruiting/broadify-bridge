#pragma once

#if defined(__APPLE__)

#import <CoreVideo/CoreVideo.h>
#import <Metal/Metal.h>

namespace broadify::meeting {

// One shared Metal device + command queue + CoreVideo texture cache for the whole
// GPU meeting pipeline (compositor, mask refiner, and the fused zero-copy path).
// Textures and IOSurfaces are only interchangeable across stages when they come
// from the SAME MTLDevice, so every GPU stage must source it here. All accessors
// return nil/nullptr when Metal is unavailable; callers fall back to the CPU path.
id<MTLDevice> sharedMetalDevice();
id<MTLCommandQueue> sharedMetalQueue();
CVMetalTextureCacheRef sharedMetalTextureCache();

}  // namespace broadify::meeting

#endif  // __APPLE__
