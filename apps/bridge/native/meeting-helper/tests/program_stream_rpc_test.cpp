// RPC surface of the WebRTC program stream through handleRpc: without a
// stream object and with the platform stub every offer is refused with a
// stable code, status/sessions stay well-formed, close is idempotent.
#include "capture/screen_capture_stub.h"
#include "control/control_server.h"
#include "live/program_stream.h"
#include "preview/preview_frame_store.h"
#include "recorder/meeting_recorder.h"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>

namespace {

using broadify::meeting::CameraInfo;
using broadify::meeting::CameraSource;
using broadify::meeting::MeetingRecorder;
using broadify::meeting::MeetingState;
using broadify::meeting::Options;
using broadify::meeting::PreviewFrameStore;
using broadify::meeting::ProgramStream;
using broadify::meeting::ProgramStreamConfig;
using broadify::meeting::StubScreenCaptureSource;
using broadify::meeting::VideoFrame;
using broadify::meeting::handleRpc;

class NullCamera final : public CameraSource {
 public:
  std::vector<CameraInfo> listCameras() override { return {}; }
  bool selectCamera(int) override { return false; }
  bool start(int, uint32_t, uint32_t, uint32_t) override { return false; }
  bool startSet(const std::vector<int> &, uint32_t, uint32_t, uint32_t) override { return false; }
  std::vector<int> activeCameraSet() const override { return {}; }
  bool setProgramCamera(int) override { return false; }
  void stop() override {}
  bool isRunning() const override { return false; }
  int activeCameraIndex() const override { return -1; }
  bool copyLatestFrame(VideoFrame &) override { return false; }
  std::string lastError() const override { return ""; }
  std::string stickyLastError() const override { return ""; }
  uint64_t stickyLastErrorAtMs() const override { return 0; }
  std::string cameraPermissionStatus() const override { return "authorized"; }
  std::string requestCameraPermission() override { return "authorized"; }
};

bool contains(const std::string &haystack, const std::string &needle) { return haystack.find(needle) != std::string::npos; }

int failures = 0;
void expect(bool condition, const std::string &what, const std::string &got) {
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << what << "\n  got: " << got << "\n";
  }
}

}  // namespace

int main() {
  MeetingState state;
  NullCamera camera;
  StubScreenCaptureSource screen;
  PreviewFrameStore frames;
  MeetingRecorder recorder;
  Options options;
  std::atomic<bool> running{true};
  const auto rpc = [&](const std::string &line, ProgramStream *stream) {
    return handleRpc(line, state, camera, screen, frames, recorder, nullptr, options, running, stream);
  };

  // No stream object wired (older main): well-formed "unsupported" answers.
  std::string out = rpc(R"({"id":"1","method":"program.stream.status","params":{}})", nullptr);
  expect(contains(out, "\"supported\":false"), "status without stream reports unsupported", out);
  out = rpc(R"({"id":"2","method":"program.sessions.list","params":{}})", nullptr);
  expect(contains(out, "\"sessions\":[]"), "sessions without stream is an empty list", out);
  out = rpc(R"({"id":"3","method":"program.viewer.offer","params":{"viewer_id":"v1","sdp":"v=0"}})", nullptr);
  expect(contains(out, "program_stream_unavailable"), "offer without stream is refused with a stable code", out);

  // Platform stub (the control_server_test build links the stub on every platform).
  ProgramStream stream(frames, state, ProgramStreamConfig{1280, 720, 30});
  stream.start();
  out = rpc(R"({"id":"4","method":"program.viewer.offer","params":{"viewer_id":"v1","sdp":"v=0","profile":"lan","ice_servers":[{"url":"stun:stun.example:3478"}]}})", &stream);
  expect(contains(out, "program_stream_unavailable"), "stub refuses offers", out);
  out = rpc(R"({"id":"5","method":"program.viewer.offer","params":{"sdp":"v=0"}})", &stream);
  expect(contains(out, "invalid_params"), "offer without viewer_id is invalid", out);
  out = rpc(R"({"id":"6","method":"program.viewer.close","params":{"viewer_id":"v1"}})", &stream);
  expect(contains(out, "\"closed\":true"), "close is idempotent", out);
  out = rpc(R"({"id":"7","method":"program.viewer.close","params":{}})", &stream);
  expect(contains(out, "invalid_params"), "close without viewer_id is invalid", out);
  out = rpc(R"({"id":"8","method":"program.stream.status","params":{}})", &stream);
  expect(contains(out, "\"viewers\":0"), "status carries the viewer count", out);
  stream.stop();

  // The pipeline publishes preview frames while the stream has a consumer registered.
  expect(state.programStreamClientCount == 0, "no consumer registered without viewers", std::to_string(state.programStreamClientCount));

  if (failures != 0) {
    return EXIT_FAILURE;
  }
  std::cout << "program_stream_rpc_test passed\n";
  return EXIT_SUCCESS;
}
