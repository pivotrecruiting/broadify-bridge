#include "encode/bitrate_ladder.h"

#include <cstdlib>
#include <iostream>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "bitrate_ladder_test failed: " << m << std::endl; std::exit(1); }

int main() {
  EncodeTarget t = selectEncodeTarget(1920, 1080, 60, 1, EncodeProfile::Lan);
  if (t.width != 1920 || t.height != 1080 || t.bitrateKbps != 8000 || t.maxBitrateKbps != 12000) fail("1080p60 lan");
  t = selectEncodeTarget(1920, 1080, 30000, 1001, EncodeProfile::Auto);
  if (t.bitrateKbps != 5000 || t.fpsNum != 30000 || t.fpsDen != 1001 || t.profileName != "lan") fail("1080p29.97 auto");
  t = selectEncodeTarget(1920, 1080, 50, 1, EncodeProfile::Lan);
  if (t.bitrateKbps != 6000) fail("1080p50");
  t = selectEncodeTarget(3840, 2160, 30, 1, EncodeProfile::Lan);
  if (t.width != 1920 || t.height != 1080) fail("4k capped to 1080p");
  t = selectEncodeTarget(1920, 1080, 60, 1, EncodeProfile::Remote);
  if (t.width != 1280 || t.height != 720 || t.fpsNum != 30 || t.bitrateKbps != 2500 || t.profileName != "remote") fail("remote 720p30");
  t = selectEncodeTarget(1280, 720, 25, 1, EncodeProfile::Remote);
  if (t.width != 1280 || t.fpsNum != 25) fail("remote keeps <=30 fps source rate");
  t = selectEncodeTarget(1280, 720, 60, 1, EncodeProfile::Lan);
  if (t.bitrateKbps != 4000) fail("720p60");
  t = selectEncodeTarget(0, 0, 0, 0, EncodeProfile::Lan);
  if (t.width < 16 || t.fpsNum != 30 || t.fpsDen != 1) fail("degenerate input clamped");
  if (parseEncodeProfile("remote") != EncodeProfile::Remote || parseEncodeProfile("x") != EncodeProfile::Auto) fail("parse");
  std::cout << "bitrate_ladder_test passed" << std::endl;
  return 0;
}
