#include "pipeline/ofd_temporal.h"

#include <iostream>
#include <memory>

using broadify::meeting::AlphaMask;
using broadify::meeting::OfdConfig;
using broadify::meeting::OfdFrameDelayQueue;
using broadify::meeting::OfdTemporal;
using broadify::meeting::VideoFrame;

namespace {

AlphaMask mask(uint64_t ts, uint8_t a) {
  AlphaMask out;
  out.width = 1;
  out.height = 1;
  out.timestampNs = ts;
  out.alpha = {a};
  return out;
}

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "ofd_temporal_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;

  {
    OfdTemporal ofd(OfdConfig{8, 24});
    AlphaMask out;
    ok &= expect(!ofd.push(mask(1, 100), out), "first frame is delayed");
    ok &= expect(!ofd.push(mask(2, 220), out), "second frame waits for next");
    ok &= expect(ofd.push(mask(3, 102), out),
                 "third frame emits delayed middle");
    ok &= expect(out.timestampNs == 2, "emitted mask keeps middle timestamp");
    ok &= expect(out.alpha[0] == 101, "single-frame flicker is replaced");
  }

  {
    OfdTemporal ofd(OfdConfig{8, 24});
    AlphaMask out;
    (void)ofd.push(mask(1, 20), out);
    (void)ofd.push(mask(2, 90), out);
    ok &= expect(ofd.push(mask(3, 160), out), "motion sequence emits");
    ok &= expect(out.alpha[0] == 90, "two-frame motion is preserved");
  }

  {
    OfdTemporal ofd;
    AlphaMask out;
    ok &= expect(ofd.delayFrames() == 1u, "OFD reports one-frame delay");
    (void)ofd.push(mask(1, 10), out);
    AlphaMask larger = mask(2, 20);
    larger.width = 2;
    larger.alpha = {20, 20};
    ok &= expect(!ofd.push(larger, out), "size change resets history");
  }
  {
    OfdFrameDelayQueue frames;
    std::shared_ptr<const VideoFrame> delayed;
    auto f1 = std::make_shared<VideoFrame>();
    auto f2 = std::make_shared<VideoFrame>();
    auto f3 = std::make_shared<VideoFrame>();
    f1->timestampNs = 1;
    f2->timestampNs = 2;
    f3->timestampNs = 3;
    ok &= expect(!frames.push(f1, delayed), "first paired frame primes");
    ok &= expect(!frames.push(f2, delayed), "second paired frame primes");
    ok &= expect(frames.push(f3, delayed) && delayed == f2,
                 "third paired frame emits advancing OFD front");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "ofd_temporal_test passed" << std::endl;
  return 0;
}
