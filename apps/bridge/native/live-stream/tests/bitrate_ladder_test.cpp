#include "live_stream/bitrate_ladder.h"

#include <cstdlib>
#include <iostream>

using namespace broadify::live;

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

  // Guard: the preview ladder keeps today's encoder options (Main, speed over
  // quality, hard 1 s rate limit, 2 s GOP) so the meeting/PGM live preview
  // stays byte-identical while the recording target diverges.
  for (const EncodeProfile profile : {EncodeProfile::Lan, EncodeProfile::Remote, EncodeProfile::Auto}) {
    const EncodeTarget preview = selectEncodeTarget(1920, 1080, 30, 1, profile);
    if (preview.h264Profile != H264Profile::Main) fail("preview target must stay H.264 Main");
    if (!preview.prioritizeSpeed) fail("preview target must keep PrioritizeEncodingSpeedOverQuality");
    if (!preview.hardRateLimit) fail("preview target must keep the hard DataRateLimits");
    if (preview.gopSeconds != 2) fail("preview target must keep the 2 s GOP");
  }
  {
    const EncodeTarget lan = selectEncodeTarget(1920, 1080, 30, 1, EncodeProfile::Lan);
    if (lan.width != 1920 || lan.height != 1080 || lan.fpsNum != 30 || lan.fpsDen != 1 || lan.bitrateKbps != 5000 ||
        lan.maxBitrateKbps != 7500 || lan.profileName != "lan") fail("lan 1080p30 ladder changed");
    const EncodeTarget remote = selectEncodeTarget(1920, 1080, 30, 1, EncodeProfile::Remote);
    if (remote.width != 1280 || remote.height != 720 || remote.fpsNum != 30 || remote.fpsDen != 1 ||
        remote.bitrateKbps != 2500 || remote.maxBitrateKbps != 3500 || remote.profileName != "remote") fail("remote 1080p30 ladder changed");
  }

  // Recording target: archive policy (0.35 bit/px, 2-40 Mbit/s), High profile,
  // quality over speed, soft rate limit, LAN geometry independent of the viewer profile.
  EncodeTarget r = selectRecordingTarget(1920, 1080, 30, 1);
  if (r.width != 1920 || r.height != 1080 || r.fpsNum != 30 || r.fpsDen != 1) fail("recording 1080p30 geometry");
  if (r.bitrateKbps != 21773 || r.maxBitrateKbps != 32659) fail("recording 1080p30 bitrate 21773/32659 kbps");
  if (r.h264Profile != H264Profile::High) fail("recording target must be H.264 High");
  if (r.prioritizeSpeed) fail("recording target must prioritize quality");
  if (r.hardRateLimit) fail("recording target must not set hard DataRateLimits");
  if (r.gopSeconds != 2) fail("recording GOP is 2 s");
  if (r.profileName != "archive") fail("recording profile name is archive");
  r = selectRecordingTarget(1920, 1080, 30000, 1001);
  if (r.bitrateKbps != 21773 || r.fpsNum != 30000 || r.fpsDen != 1001) fail("29.97 keeps the source rate and the 30 fps bitrate");
  r = selectRecordingTarget(1920, 1080, 60, 1);
  if (r.bitrateKbps != 40000 || r.maxBitrateKbps != 60000) fail("1080p60 clamps to 40 Mbit/s");
  r = selectRecordingTarget(1920, 1080, 25, 1);
  if (r.bitrateKbps != 18144) fail("1080p25 is 18144 kbps");
  r = selectRecordingTarget(3840, 2160, 30, 1);
  if (r.width != 1920 || r.height != 1080 || r.bitrateKbps != 21773) fail("4K30 records as 1080p30");
  r = selectRecordingTarget(1280, 720, 30, 1);
  if (r.width != 1280 || r.height != 720 || r.bitrateKbps != 9677) fail("720p30 is 9677 kbps");
  r = selectRecordingTarget(0, 0, 0, 0);
  if (r.width < 16 || r.fpsNum != 30 || r.fpsDen != 1 || r.bitrateKbps != 2000) fail("degenerate recording input clamps to 30 fps / 2000 kbps");

  // Landscape results stay exactly what they were before portrait support,
  // including sources wider than 16:9 and square ones (the height is capped).
  t = selectEncodeTarget(2560, 1080, 30, 1, EncodeProfile::Lan);
  if (t.width != 2560 || t.height != 1080 || t.bitrateKbps != 5000 || t.maxBitrateKbps != 7500) fail("2560x1080 lan unchanged");
  t = selectEncodeTarget(2560, 1080, 30, 1, EncodeProfile::Remote);
  if (t.width != 1706 || t.height != 720 || t.bitrateKbps != 2500) fail("2560x1080 remote unchanged");
  t = selectEncodeTarget(3840, 2160, 60, 1, EncodeProfile::Remote);
  if (t.width != 1280 || t.height != 720 || t.fpsNum != 30 || t.fpsDen != 1) fail("4k60 remote unchanged");
  t = selectEncodeTarget(2560, 1440, 30, 1, EncodeProfile::Lan);
  if (t.width != 1920 || t.height != 1080 || t.bitrateKbps != 5000) fail("1440p lan unchanged");
  t = selectEncodeTarget(1920, 1920, 30, 1, EncodeProfile::Lan);
  if (t.width != 1080 || t.height != 1080 || t.bitrateKbps != 5000) fail("square lan unchanged");
  t = selectEncodeTarget(640, 360, 30, 1, EncodeProfile::Lan);
  if (t.width != 640 || t.height != 360 || t.bitrateKbps != 1500 || t.maxBitrateKbps != 2500) fail("360p lan unchanged");
  r = selectRecordingTarget(2560, 1080, 30, 1);
  if (r.width != 2560 || r.height != 1080 || r.bitrateKbps != 29030) fail("2560x1080 recording unchanged");

  // Portrait: computed transposed, so the short edge is capped and the
  // orientation survives; everything but width/height equals the landscape twin.
  t = selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Lan);
  if (t.width != 1080 || t.height != 1920 || t.fpsNum != 30 || t.fpsDen != 1 || t.bitrateKbps != 5000 ||
      t.maxBitrateKbps != 7500 || t.profileName != "lan") fail("1080x1920 lan stays 1080x1920");
  t = selectEncodeTarget(1080, 1920, 30, 1, EncodeProfile::Auto);
  if (t.width != 1080 || t.height != 1920 || t.profileName != "lan") fail("1080x1920 auto stays 1080x1920");
  t = selectEncodeTarget(1080, 1920, 60, 1, EncodeProfile::Lan);
  if (t.width != 1080 || t.height != 1920 || t.bitrateKbps != 8000 || t.maxBitrateKbps != 12000) fail("1080x1920p60 lan");
  t = selectEncodeTarget(1080, 1920, 60, 1, EncodeProfile::Remote);
  if (t.width != 720 || t.height != 1280 || t.fpsNum != 30 || t.fpsDen != 1 || t.bitrateKbps != 2500 ||
      t.maxBitrateKbps != 3500 || t.profileName != "remote") fail("1080x1920 remote is 720x1280");
  t = selectEncodeTarget(2160, 3840, 30, 1, EncodeProfile::Lan);
  if (t.width != 1080 || t.height != 1920 || t.bitrateKbps != 5000) fail("2160x3840 lan capped to 1080x1920");
  t = selectEncodeTarget(2160, 3840, 30, 1, EncodeProfile::Remote);
  if (t.width != 720 || t.height != 1280) fail("2160x3840 remote capped to 720x1280");
  t = selectEncodeTarget(720, 1280, 30, 1, EncodeProfile::Lan);
  if (t.width != 720 || t.height != 1280 || t.bitrateKbps != 2500 || t.maxBitrateKbps != 4000) fail("720x1280 lan");
  t = selectEncodeTarget(1080, 2560, 30, 1, EncodeProfile::Remote);
  if (t.width != 720 || t.height != 1706) fail("1080x2560 remote mirrors 2560x1080");
  for (const EncodeProfile profile : {EncodeProfile::Lan, EncodeProfile::Remote, EncodeProfile::Auto}) {
    const EncodeTarget portrait = selectEncodeTarget(1080, 1920, 30, 1, profile);
    if (portrait.h264Profile != H264Profile::Main || !portrait.prioritizeSpeed || !portrait.hardRateLimit ||
        portrait.gopSeconds != 2) fail("portrait preview target must keep the preview encoder options");
  }
  r = selectRecordingTarget(1080, 1920, 30, 1);
  if (r.width != 1080 || r.height != 1920 || r.fpsNum != 30 || r.fpsDen != 1 || r.bitrateKbps != 21773 ||
      r.maxBitrateKbps != 32659) fail("1080x1920 recording keeps 1080x1920 at the 1080p30 bitrate");
  if (r.h264Profile != H264Profile::High || r.prioritizeSpeed || r.hardRateLimit || r.gopSeconds != 2 ||
      r.profileName != "archive") fail("portrait recording target must keep the archive encoder options");
  r = selectRecordingTarget(2160, 3840, 30, 1);
  if (r.width != 1080 || r.height != 1920 || r.bitrateKbps != 21773) fail("2160x3840 records as 1080x1920");
  r = selectRecordingTarget(720, 1280, 30000, 1001);
  if (r.width != 720 || r.height != 1280 || r.bitrateKbps != 9677 || r.fpsNum != 30000 || r.fpsDen != 1001) fail("720x1280 recording");
  std::cout << "bitrate_ladder_test passed" << std::endl;
  return 0;
}
