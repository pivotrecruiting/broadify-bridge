#include "live_stream/h264_annexb.h"

#include <cstdlib>
#include <iostream>
#include <vector>

using namespace broadify::live;

static void fail(const char *m) { std::cerr << "h264_annexb_test failed: " << m << std::endl; std::exit(1); }

int main() {
  // Two NALs, 4-byte lengths: an IDR slice (type 5) and a filler (type 12).
  const std::vector<uint8_t> avcc = {0, 0, 0, 3, 0x65, 0xaa, 0xbb, 0, 0, 0, 2, 0x6c, 0x01};
  std::vector<uint8_t> annexB;
  if (!avccToAnnexB(avcc.data(), avcc.size(), 4, annexB)) fail("conversion rejected valid input");
  const std::vector<uint8_t> expected = {0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0, 0, 0, 1, 0x6c, 0x01};
  if (annexB != expected) fail("annex b bytes differ");
  if (firstNalType(annexB) != 5) fail("first nal type");
  if (!containsIdr(annexB)) fail("idr not detected");

  std::vector<uint8_t> truncated;
  if (avccToAnnexB(avcc.data(), avcc.size() - 1, 4, truncated)) fail("truncated input accepted");
  std::vector<uint8_t> badLen;
  if (avccToAnnexB(avcc.data(), avcc.size(), 5, badLen)) fail("invalid nal length size accepted");

  H264ParameterSets sets;
  sets.sps = {0x67, 0x42, 0xe0, 0x1f};
  sets.pps = {0x68, 0xce, 0x38, 0x80};
  std::vector<uint8_t> frame = expected;
  prependParameterSets(sets, frame);
  if (firstNalType(frame) != 7) fail("sps not first after prepend");
  if (!containsIdr(frame)) fail("idr lost after prepend");
  if (frame.size() != expected.size() + 16) fail("prepend size");

  std::vector<uint8_t> nonIdr = {0, 0, 1, 0x41, 0x00};
  if (containsIdr(nonIdr)) fail("false idr");
  if (firstNalType(nonIdr) != 1) fail("3-byte start code not parsed");
  std::cout << "h264_annexb_test passed" << std::endl;
  return 0;
}
