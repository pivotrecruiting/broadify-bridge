#pragma once

#include <cstdint>

#if defined(__APPLE__)
#include <mach/mach_time.h>
#else
#include <chrono>
#endif

namespace broadify::pgm {

/**
 * One clock for everything time-related in the helper. On macOS this is the
 * host clock (mach_absolute_time), the same base AVFoundation stamps its
 * sample buffers with; elsewhere std::steady_clock. Never mix with wall time.
 */
inline uint64_t monotonicNowNs() {
#if defined(__APPLE__)
  static mach_timebase_info_data_t info = {0, 0};
  if (info.denom == 0) {
    mach_timebase_info(&info);
  }
  return mach_absolute_time() * info.numer / info.denom;
#else
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
#endif
}

}  // namespace broadify::pgm
