#include "audio/audio_pairing.h"

namespace broadify::pgm {
namespace {

std::string lowerAscii(std::string value) {
  for (char &ch : value) {
    if (ch >= 'A' && ch <= 'Z') {
      ch = static_cast<char>(ch - 'A' + 'a');
    }
  }
  return value;
}

/** Lower-case hex digits of a GUID string, braces and dashes dropped. */
std::string containerKey(const std::string &containerId) {
  std::string key;
  for (const char ch : lowerAscii(containerId)) {
    if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
      key.push_back(ch);
    }
  }
  return key;
}

bool pairableContainer(const std::string &key) {
  // GUID_NULL: unknown. {00000000-0000-0000-FFFF-FFFFFFFFFFFF}: the computer itself.
  return key.size() == 32 && key != "00000000000000000000000000000000" && key != "0000000000000000ffffffffffffffff";
}

bool namesMatch(const std::string &wanted, const std::string &name) {
  if (name.empty() || wanted.empty()) {
    return false;
  }
  return name == wanted || (wanted.size() >= 4 && name.find(wanted) != std::string::npos) ||
         (name.size() >= 4 && wanted.find(name) != std::string::npos);
}

}  // namespace

AudioPairing pairAudioEndpoint(const std::string &videoDisplayName, const std::string &videoContainerId,
                               const std::vector<AudioEndpointCandidate> &candidates) {
  AudioPairing pairing;
  const std::string container = containerKey(videoContainerId);
  if (pairableContainer(container)) {
    for (size_t index = 0; index < candidates.size(); ++index) {
      if (containerKey(candidates[index].containerId) == container) {
        pairing.index = static_cast<int>(index);
        pairing.rule = "container";
        return pairing;
      }
    }
  }
  const std::string wanted = lowerAscii(videoDisplayName);
  for (size_t index = 0; index < candidates.size(); ++index) {
    if (namesMatch(wanted, lowerAscii(candidates[index].name)) || namesMatch(wanted, lowerAscii(candidates[index].deviceName))) {
      pairing.index = static_cast<int>(index);
      pairing.rule = "name";
      return pairing;
    }
  }
  return pairing;
}

}  // namespace broadify::pgm
