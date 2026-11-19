#include "../src/framebus-reader-policy.h"

#include <cassert>
#include <cstdint>

int main() {
  constexpr uint64_t kThresholdNs = 2'000'000'000ULL;

  assert(!decklink_helper::shouldReopenStaleReader(0, 0, kThresholdNs));
  assert(!decklink_helper::shouldReopenStaleReader(1'999'999'999ULL, 0, kThresholdNs));
  assert(!decklink_helper::shouldReopenStaleReader(2'999'999'999ULL, 1'000'000'000ULL, kThresholdNs));
  assert(decklink_helper::shouldReopenStaleReader(3'000'000'000ULL, 1'000'000'000ULL, kThresholdNs));
  assert(!decklink_helper::shouldReopenStaleReader(999'999'999ULL, 1'000'000'000ULL, kThresholdNs));
  assert(!decklink_helper::shouldReopenStaleReader(3'000'000'000ULL, 1'000'000'000ULL, 0));

  assert(!decklink_helper::isTornRead(10, 10, 2));
  assert(decklink_helper::isTornRead(10, 11, 2));
  assert(decklink_helper::isTornRead(10, 12, 2));
  assert(decklink_helper::isTornRead(10, 13, 2));

  assert(!decklink_helper::isTornRead(20, 21, 3));
  assert(decklink_helper::isTornRead(20, 22, 3));
  assert(decklink_helper::isTornRead(20, 23, 3));
  assert(decklink_helper::isTornRead(20, 24, 3));

  assert(decklink_helper::isTornRead(30, 29, 3));
  assert(!decklink_helper::isTornRead(30, 31, 0));
  assert(!decklink_helper::isTornRead(0, 31, 3));
  assert(decklink_helper::isTornRead(40, 41, 1));

  return 0;
}
