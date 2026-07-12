#pragma once

#include <stdint.h>

#if defined(_WIN32) && defined(_MSC_VER)
#include <windows.h>

static inline uint64_t framebus_atomic_load_u64(const uint64_t *value) {
  /* Must be a plain load: readers map the FrameBus section FILE_MAP_READ, and
   * InterlockedCompareExchange64 is a lock cmpxchg that WRITES to the target,
   * which access-violates on a read-only mapping. ReadAcquire64 is an
   * acquire-ordered 64-bit volatile read (atomic on x64). */
  return (uint64_t)ReadAcquire64((const volatile LONG64 *)value);
}

static inline void framebus_atomic_store_u64(uint64_t *target, uint64_t value) {
  InterlockedExchange64((volatile LONG64 *)target, (LONG64)value);
}
#else
#include <stdatomic.h>

static inline uint64_t framebus_atomic_load_u64(const uint64_t *value) {
  const _Atomic uint64_t *ptr = (const _Atomic uint64_t *)value;
  return atomic_load_explicit(ptr, memory_order_acquire);
}

static inline void framebus_atomic_store_u64(uint64_t *target, uint64_t value) {
  _Atomic uint64_t *ptr = (_Atomic uint64_t *)target;
  atomic_store_explicit(ptr, value, memory_order_release);
}
#endif
