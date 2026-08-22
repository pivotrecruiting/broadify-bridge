#pragma once

#include <atomic>

namespace broadify::vcam {

enum class RawFrameConnectState {
  Connecting,
  Connected,
  Failed,
};

class RawFrameConnectStateMachine {
 public:
  void markConnecting() {
    state_.store(RawFrameConnectState::Connecting, std::memory_order_release);
  }

  void markConnected() {
    state_.store(RawFrameConnectState::Connected, std::memory_order_release);
  }

  void markFailed() {
    state_.store(RawFrameConnectState::Failed, std::memory_order_release);
  }

  RawFrameConnectState state() const {
    return state_.load(std::memory_order_acquire);
  }

  bool attemptFinished() const {
    const RawFrameConnectState current = state();
    return current == RawFrameConnectState::Connected ||
           current == RawFrameConnectState::Failed;
  }

 private:
  std::atomic<RawFrameConnectState> state_{RawFrameConnectState::Failed};
};

}  // namespace broadify::vcam
