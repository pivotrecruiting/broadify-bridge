#pragma once

// Shared runtime SIMD-capability probe. Hand-written AVX2 kernels must be gated
// behind a runtime check so a binary built with AVX2 intrinsics still runs on
// CPUs without AVX2 (falling back to scalar) instead of faulting with an illegal
// instruction — we deliberately do NOT compile with a global /arch:AVX2.
//
// Only meaningful on Windows x86/x64 (the only target where these kernels run);
// elsewhere callers take the scalar path and never reference this.

#if defined(_WIN32) && (defined(_M_X64) || defined(_M_IX86))
#include <intrin.h>

namespace broadify::meeting {

inline bool cpuHasAvx2() {
  int regs[4] = {};
  __cpuid(regs, 0);
  if (regs[0] < 7) {
    return false;
  }
  __cpuidex(regs, 7, 0);
  return (regs[1] & (1 << 5)) != 0;  // CPUID.(EAX=7,ECX=0):EBX.AVX2[bit 5]
}

}  // namespace broadify::meeting
#endif
