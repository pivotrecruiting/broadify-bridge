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

  // profile_idc is the byte after the SPS NAL header: 77 = Main, 100 = High.
  if (spsProfileIdc(frame) != 66) fail("synthetic SPS 0x42 is Baseline (66)");
  H264ParameterSets mainSets;
  mainSets.sps = {0x67, 0x4d, 0x40, 0x1f};
  std::vector<uint8_t> mainFrame = expected;
  prependParameterSets(mainSets, mainFrame);
  if (spsProfileIdc(mainFrame) != 77) fail("Main SPS profile_idc");
  H264ParameterSets highSets;
  highSets.sps = {0x67, 0x64, 0x00, 0x1f};
  highSets.pps = {0x68, 0xee, 0x3c, 0x80};
  std::vector<uint8_t> highFrame = expected;
  prependParameterSets(highSets, highFrame);
  if (spsProfileIdc(highFrame) != 100) fail("High SPS profile_idc");
  if (spsProfileIdc(expected) != -1) fail("no SPS must give -1");
  const std::vector<uint8_t> truncatedSps = {0, 0, 0, 1, 0x67};
  if (spsProfileIdc(truncatedSps) != -1) fail("SPS without profile byte must give -1");

  if (!containsNalType(frame, 7) || !containsNalType(frame, 8) || !containsNalType(frame, 5)) fail("nal types of a keyframe");
  if (!containsNalType(frame, 12)) fail("last nal type not found");
  if (containsNalType(nonIdr, 5) || containsNalType(nonIdr, 7)) fail("false nal type");
  if (!containsNalType(nonIdr, 1)) fail("slice type behind 3-byte start code");
  if (containsNalType({}, 1)) fail("empty buffer has no nal");

  // Sequence header as an encoder MFT publishes it: 4-byte start codes, SPS then PPS.
  const std::vector<uint8_t> header = {0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80};
  H264ParameterSets split;
  if (!splitAnnexBParameterSets(header.data(), header.size(), split)) fail("sequence header rejected");
  if (split.sps != std::vector<uint8_t>{0x67, 0x64, 0x00, 0x1f, 0xac}) fail("sps bytes (inner zero byte must survive)");
  if (split.pps != std::vector<uint8_t>{0x68, 0xee, 0x3c, 0x80}) fail("pps bytes");
  // Round trip: prepending the split sets rebuilds the header.
  std::vector<uint8_t> rebuilt;
  prependParameterSets(split, rebuilt);
  if (rebuilt != header) fail("split + prepend must rebuild the header");

  // 3-byte start codes, PPS first, an AUD and an SEI around, trailing zero bytes, a second SPS.
  const std::vector<uint8_t> mixed = {0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80, 0, 0, 1, 0x06, 0x05,
                                      0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f, 0, 0};
  if (!splitAnnexBParameterSets(mixed.data(), mixed.size(), split)) fail("mixed header rejected");
  if (split.sps != std::vector<uint8_t>{0x67, 0x42, 0xe0, 0x1f}) fail("first sps wins, zeros before the next start code dropped");
  if (split.pps != std::vector<uint8_t>{0x68, 0xce, 0x38, 0x80}) fail("pps of the mixed header");

  split.sps = {1};
  split.pps = {2};
  const std::vector<uint8_t> spsOnly = {0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f};
  if (splitAnnexBParameterSets(spsOnly.data(), spsOnly.size(), split)) fail("header without pps accepted");
  if (!split.sps.empty() || !split.pps.empty()) fail("failed split must clear the output");
  const std::vector<uint8_t> noStartCode = {0x67, 0x42, 0xe0, 0x1f, 0x68, 0xce};
  if (splitAnnexBParameterSets(noStartCode.data(), noStartCode.size(), split)) fail("blob without start code accepted");
  const std::vector<uint8_t> emptyNals = {0, 0, 1, 0, 0, 1, 0, 0, 0, 1};
  if (splitAnnexBParameterSets(emptyNals.data(), emptyNals.size(), split)) fail("empty nals accepted");
  if (splitAnnexBParameterSets(nullptr, 0, split)) fail("null blob accepted");
  if (splitAnnexBParameterSets(header.data(), 0, split)) fail("empty blob accepted");

  std::cout << "h264_annexb_test passed" << std::endl;
  return 0;
}
