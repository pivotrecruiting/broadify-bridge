#include "../../vcam-helper/windows/raw_frame_connect_state.h"

#include <iostream>

using broadify::vcam::RawFrameConnectState;
using broadify::vcam::RawFrameConnectStateMachine;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "raw_frame_connect_state_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  RawFrameConnectStateMachine state;
  bool ok = true;
  ok &= expect(state.state() == RawFrameConnectState::Failed,
               "initial state is failed/idle");
  ok &= expect(state.attemptFinished(), "initial state is not connecting");
  state.markConnecting();
  ok &= expect(state.state() == RawFrameConnectState::Connecting,
               "markConnecting sets connecting");
  ok &= expect(!state.attemptFinished(),
               "connecting attempt is not finished");
  state.markConnected();
  ok &= expect(state.state() == RawFrameConnectState::Connected,
               "markConnected sets connected");
  ok &= expect(state.attemptFinished(), "connected attempt is finished");
  state.markConnecting();
  state.markFailed();
  ok &= expect(state.state() == RawFrameConnectState::Failed,
               "markFailed sets failed");
  ok &= expect(state.attemptFinished(), "failed attempt is finished");
  return ok ? 0 : 1;
}
