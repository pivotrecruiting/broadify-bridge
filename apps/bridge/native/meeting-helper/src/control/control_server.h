#pragma once

#include "capture/camera_source.h"
#include "common/options.h"
#include "state/meeting_state.h"

#include <atomic>
#include <functional>
#include <string>

namespace broadify::meeting {

void runControlServer(const std::string &socketPath,
                      MeetingState &state,
                      CameraSource &camera,
                      const Options &options,
                      std::atomic<bool> &running,
                      const std::function<void()> &onListening = {});

}  // namespace broadify::meeting
