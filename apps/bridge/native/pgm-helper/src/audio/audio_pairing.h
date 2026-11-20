#pragma once

#include <string>
#include <vector>

namespace broadify::pgm {

/** One active audio capture endpoint as the platform reports it. */
struct AudioEndpointCandidate {
  std::string id;           // backend id (Windows: IMMDevice id)
  std::string name;         // endpoint name, e.g. "Microphone (ATEM Mini)"
  std::string deviceName;   // name of the device behind the endpoint, e.g. "ATEM Mini"; may be empty
  std::string containerId;  // GUID string of the physical device the endpoint belongs to; may be empty
};

struct AudioPairing {
  int index = -1;             // into the candidate list; -1: no paired audio (video-only preview)
  const char *rule = "none";  // "container" | "name" | "none"
};

/**
 * Finds the audio endpoint that belongs to a video device. First the endpoint
 * in the same device container (one USB device exposing video and audio, e.g.
 * ATEM Mini, RODECaster Video), which also keeps two identical switchers
 * apart. The null container and the computer's own container (everything
 * built in shares it) never pair that way. Otherwise the name rule of the
 * macOS backend (audio_capture_avfoundation.mm): equal names, or one name of
 * at least 4 characters contained in the other, compared in lower case
 * (ASCII letters only; the names are UTF-8). Never the default microphone.
 */
AudioPairing pairAudioEndpoint(const std::string &videoDisplayName, const std::string &videoContainerId,
                               const std::vector<AudioEndpointCandidate> &candidates);

}  // namespace broadify::pgm
