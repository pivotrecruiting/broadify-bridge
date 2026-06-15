#pragma once

#include "common/options.h"
#include "keyer/keyer.h"
#include "keyer/modnet_keyer.h"
#include "state/meeting_state.h"

#include <mutex>
#include <memory>

namespace broadify::meeting {

class KeyerChain {
 public:
  explicit KeyerChain(const Options &options);

  KeyerResult process(const VideoFrame &input, const MeetingState &state);
  KeyerStatus status() const;

 private:
  mutable std::mutex mutex_;
  ModnetKeyerOptions options_;
  std::unique_ptr<Keyer> modnet_;
  std::unique_ptr<Keyer> vision_;
  KeyerStatus status_;
};

void updateMeetingKeyerStatus(MeetingState &state, const KeyerStatus &status);

}  // namespace broadify::meeting
