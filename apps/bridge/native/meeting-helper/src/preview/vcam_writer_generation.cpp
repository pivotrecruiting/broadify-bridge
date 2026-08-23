#include "preview/vcam_writer_generation.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace broadify::meeting {

uint64_t initialVcamWriterGeneration() {
#if defined(_WIN32)
  return (static_cast<uint64_t>(GetCurrentProcessId()) << 32u) ^
         static_cast<uint64_t>(GetTickCount64());
#else
  return 1u;
#endif
}

}  // namespace broadify::meeting
