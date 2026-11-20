// Pairing of a video device with its audio endpoint: same device container
// first, else the name rule of the macOS backend, never a default microphone.
#include "audio/audio_pairing.h"

#include <cstdlib>
#include <cstring>
#include <iostream>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "audio_pairing_test failed: " << m << std::endl; std::exit(1); }

static AudioEndpointCandidate endpoint(const char *name, const char *deviceName, const char *containerId) {
  AudioEndpointCandidate c;
  c.id = name;
  c.name = name;
  c.deviceName = deviceName;
  c.containerId = containerId;
  return c;
}

static void expect(const AudioPairing &pairing, int index, const char *rule, const char *what) {
  if (pairing.index != index || std::strcmp(pairing.rule, rule) != 0) fail(what);
}

int main() {
  const char *ATEM = "{11111111-2222-3333-4444-555555555555}";
  const char *ATEM_2 = "{AAAAAAAA-2222-3333-4444-555555555555}";
  const char *COMPUTER = "{00000000-0000-0000-FFFF-FFFFFFFFFFFF}";
  const char *NONE = "{00000000-0000-0000-0000-000000000000}";

  expect(pairAudioEndpoint("ATEM Mini", ATEM, {}), -1, "none", "no endpoints");

  // Container beats name: the endpoint of the same USB device, whatever it is called.
  expect(pairAudioEndpoint("ATEM Mini", ATEM,
                           {endpoint("Microphone (ATEM Mini)", "ATEM Mini", ATEM_2), endpoint("Line (USB Audio)", "USB Audio", ATEM)}),
         1, "container", "container first");
  // Two identical switchers: each video device gets its own audio.
  const std::vector<AudioEndpointCandidate> twins = {endpoint("Microphone (ATEM Mini)", "ATEM Mini", ATEM),
                                                     endpoint("Microphone (2- ATEM Mini)", "ATEM Mini", ATEM_2)};
  expect(pairAudioEndpoint("ATEM Mini", ATEM, twins), 0, "container", "first twin");
  expect(pairAudioEndpoint("ATEM Mini", ATEM_2, twins), 1, "container", "second twin");
  // GUID spelling does not matter (case, braces).
  expect(pairAudioEndpoint("ATEM Mini", "aaaaaaaa-2222-3333-4444-555555555555", twins), 1, "container", "guid spelling");

  // Built-in devices share the computer's container: that is not a pairing.
  expect(pairAudioEndpoint("Integrated Camera", COMPUTER, {endpoint("Microphone Array (Realtek Audio)", "Realtek Audio", COMPUTER)}),
         -1, "none", "computer container");
  expect(pairAudioEndpoint("Some Camera", NONE, {endpoint("Microphone (Other)", "Other", NONE)}), -1, "none", "null container");
  expect(pairAudioEndpoint("Some Camera", "", {endpoint("Microphone (Other)", "Other", "")}), -1, "none", "empty container");

  // Name rule (macOS): equal, or one name of at least 4 characters inside the other, lower case.
  expect(pairAudioEndpoint("ATEM Mini", "", {endpoint("Realtek Mic", "", ""), endpoint("atem mini", "", "")}), 1, "name", "equal names");
  expect(pairAudioEndpoint("ATEM Mini", "", {endpoint("Microphone (ATEM Mini)", "", "")}), 0, "name", "endpoint contains video name");
  expect(pairAudioEndpoint("ATEM Mini Pro ISO", "", {endpoint("ATEM Mini", "", "")}), 0, "name", "video name contains endpoint");
  expect(pairAudioEndpoint("ATEM Mini", NONE, {endpoint("Digital Audio Interface", "ATEM Mini", "")}), 0, "name", "device name");
  // RODECaster with its non-ASCII letter (UTF-8 bytes) pairs by name as well.
  expect(pairAudioEndpoint("R\xC3\x98" "DECaster Video", "", {endpoint("Mikrofon (R\xC3\x98" "DECaster Video)", "", "")}), 0, "name",
         "utf-8 name");
  // Names shorter than 4 characters only pair when equal.
  expect(pairAudioEndpoint("Cam", "", {endpoint("Webcam Microphone", "", "")}), -1, "none", "short video name");
  expect(pairAudioEndpoint("USB Camera", "", {endpoint("USB", "", "")}), -1, "none", "short endpoint name");
  expect(pairAudioEndpoint("Cam", "", {endpoint("cam", "", "")}), 0, "name", "short but equal");
  // No relation: video only, never some default microphone.
  expect(pairAudioEndpoint("ATEM Mini", ATEM, {endpoint("Microphone (Realtek Audio)", "Realtek Audio", COMPUTER),
                                              endpoint("Headset (Jabra)", "Jabra", ATEM_2)}),
         -1, "none", "unrelated endpoints");
  expect(pairAudioEndpoint("", "", {endpoint("", "", "")}), -1, "none", "empty names");

  std::cout << "audio_pairing_test passed" << std::endl;
  return 0;
}
