#include "control/control_server.h"
#include "capture/screen_capture_stub.h"
#include "preview/preview_frame_store.h"
#include "recorder/meeting_recorder.h"

#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace {

using broadify::meeting::CameraInfo;
using broadify::meeting::CameraSource;
using broadify::meeting::MeetingRecorder;
using broadify::meeting::MeetingState;
using broadify::meeting::Options;
using broadify::meeting::PreviewFrameStore;
using broadify::meeting::StubScreenCaptureSource;
using broadify::meeting::VideoFrame;
using broadify::meeting::handleRpc;
using broadify::meeting::runControlServer;

void fail(const char *message) {
  std::cerr << "control_server_test failed: " << message << std::endl;
  std::exit(1);
}

bool contains(const std::string &value, const std::string &needle) {
  return value.find(needle) != std::string::npos;
}

class StubCameraSource final : public CameraSource {
 public:
  std::vector<CameraInfo> listCameras() override {
    CameraInfo first;
    first.cameraIndex = 0;
    first.label = "Camera A";
    first.cameraId = "camera-a-id";
    first.stableKey = "camera-a-key";
    first.backend = "stub";
    first.available = true;
    first.active = running_ && activeIndex_ == 0;

    CameraInfo second;
    second.cameraIndex = 1;
    second.label = "Camera B";
    second.cameraId = "camera-b-id";
    second.stableKey = "camera-b-key";
    second.backend = "stub";
    second.available = true;
    second.active = running_ && activeIndex_ == 1;
    return {first, second};
  }

  bool selectCamera(int cameraIndex) override {
    activeIndex_ = cameraIndex;
    return true;
  }

  bool start(int cameraIndex, uint32_t width, uint32_t height,
             uint32_t fps) override {
    ++startCalls;
    startedIndices.push_back(cameraIndex);
    lastWidth = width;
    lastHeight = height;
    lastFps = fps;
    running_ = true;
    activeIndex_ = cameraIndex;
    // Mirror the real backends: start() opens a capture session, so the camera
    // becomes visible in activeCameraSet(). selectCamera() deliberately does NOT
    // do this — it only moves the program pointer — which is what the
    // switch-camera regression below exercises.
    openSet_ = {cameraIndex};
    return true;
  }

  bool startSet(const std::vector<int> &cameraIndices, uint32_t width,
                uint32_t height, uint32_t fps) override {
    ++startSetCalls;
    lastStartSetIndices = cameraIndices;
    lastWidth = width;
    lastHeight = height;
    lastFps = fps;
    if (cameraIndices.empty()) {
      return false;
    }
    openSet_ = cameraIndices;
    running_ = true;
    activeIndex_ = cameraIndices.front();
    return true;
  }

  std::vector<int> activeCameraSet() const override { return openSet_; }

  bool setProgramCamera(int cameraIndex) override {
    programSelectIndex = cameraIndex;
    activeIndex_ = cameraIndex;
    return true;
  }

  void stop() override {
    running_ = false;
    activeIndex_ = -1;
    openSet_.clear();
  }

  bool isRunning() const override { return running_; }
  int activeCameraIndex() const override { return activeIndex_; }
  bool copyLatestFrame(VideoFrame &) override { return false; }
  std::string lastError() const override { return liveError; }
  std::string stickyLastError() const override { return stickyError; }
  uint64_t stickyLastErrorAtMs() const override { return stickyErrorAtMs; }
  std::string cameraPermissionStatus() const override { return "authorized"; }
  std::string requestCameraPermission() override { return "authorized"; }

  std::string liveError;
  std::string stickyError;
  uint64_t stickyErrorAtMs = 0;

  int startCalls = 0;
  int startSetCalls = 0;
  int programSelectIndex = -1;
  uint32_t lastWidth = 0;
  uint32_t lastHeight = 0;
  uint32_t lastFps = 0;
  std::vector<int> startedIndices;
  std::vector<int> lastStartSetIndices;

 private:
  bool running_ = false;
  int activeIndex_ = -1;
  std::vector<int> openSet_;
};

#if defined(_WIN32)
bool canBindControlEndpoint(const std::string &) {
  return true;
}

std::string controlEndpoint() {
  return "\\\\.\\pipe\\broadify-control-server-test-" +
         std::to_string(GetCurrentProcessId());
}

std::string sendRpc(const std::string &endpoint, const std::string &request) {
  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (int attempt = 0; attempt < 100; ++attempt) {
    pipe = CreateFileA(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                       nullptr, OPEN_EXISTING, 0, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) {
      break;
    }
    Sleep(10);
  }
  if (pipe == INVALID_HANDLE_VALUE) {
    fail("CreateFileA");
  }
  DWORD written = 0;
  const std::string line = request + "\n";
  if (!WriteFile(pipe, line.data(), static_cast<DWORD>(line.size()), &written,
                 nullptr)) {
    CloseHandle(pipe);
    fail("WriteFile");
  }
  char buffer[8192];
  DWORD readBytes = 0;
  std::string response;
  while (ReadFile(pipe, buffer, sizeof(buffer), &readBytes, nullptr) &&
         readBytes > 0) {
    response.append(buffer, buffer + readBytes);
  }
  CloseHandle(pipe);
  return response;
}
#else
bool canBindControlEndpoint(const std::string &endpoint) {
  const int socketHandle = static_cast<int>(socket(AF_UNIX, SOCK_STREAM, 0));
  if (socketHandle < 0) {
    return false;
  }
  unlink(endpoint.c_str());
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", endpoint.c_str());
  const bool ok =
      bind(socketHandle, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == 0;
  close(socketHandle);
  unlink(endpoint.c_str());
  return ok;
}

std::string controlEndpoint() {
  const char *tmpDir = std::getenv("TMPDIR");
  const std::string base = tmpDir && *tmpDir ? tmpDir : "/tmp";
  return base + "/broadify-control-server-test-" + std::to_string(getpid()) +
         ".sock";
}

std::string sendRpc(const std::string &endpoint, const std::string &request) {
  const int socketHandle = static_cast<int>(socket(AF_UNIX, SOCK_STREAM, 0));
  if (socketHandle < 0) {
    fail("socket");
  }
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", endpoint.c_str());
  if (connect(socketHandle, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) !=
      0) {
    close(socketHandle);
    fail("connect");
  }
  const std::string line = request + "\n";
  if (write(socketHandle, line.data(), line.size()) < 0) {
    close(socketHandle);
    fail("write");
  }
  char buffer[8192];
  std::string response;
  ssize_t readBytes = 0;
  while ((readBytes = read(socketHandle, buffer, sizeof(buffer))) > 0) {
    response.append(buffer, buffer + readBytes);
  }
  close(socketHandle);
  return response;
}
#endif

}  // namespace

int main() {
  StubCameraSource camera;
  StubScreenCaptureSource screen;
  MeetingState state;
  PreviewFrameStore previewFrames;
  MeetingRecorder recorder;
  Options options;
  options.width = 1280;
  options.height = 720;
  options.fps = 30;
  std::atomic<bool> running{true};
  std::mutex readyMutex;
  std::condition_variable readyCv;
  bool ready = false;
  const std::string endpoint = controlEndpoint();
  const bool socketMode = canBindControlEndpoint(endpoint);

  std::thread server;
  if (socketMode) {
    server = std::thread([&] {
      runControlServer(endpoint, state, camera, screen, previewFrames, recorder,
                       options, running, [&] {
                         std::lock_guard<std::mutex> lock(readyMutex);
                         ready = true;
                         readyCv.notify_all();
                       });
    });

    {
      std::unique_lock<std::mutex> lock(readyMutex);
      if (!readyCv.wait_for(lock, std::chrono::seconds(3),
                            [&] { return ready; })) {
        running.store(false);
        if (server.joinable()) {
          server.join();
        }
        fail("server did not start");
      }
    }
  } else {
    std::cout << "control_server_test: socket bind unavailable, using direct RPC"
              << std::endl;
  }

  auto stopServer = [&] {
    running.store(false);
    if (server.joinable()) {
      server.join();
    }
  };

  auto rpc = [&](const std::string &request) {
    if (socketMode) {
      return sendRpc(endpoint, request);
    }
    return handleRpc(request, state, camera, screen, previewFrames, recorder,
                     nullptr, options, running);
  };

  const std::string first =
      rpc("{\"id\":\"1\",\"method\":\"camera.start\","
                        "\"camera_index\":0}");
  if (!contains(first, "\"reopened\":true") || camera.startCalls != 1) {
    stopServer();
    fail("first camera.start did not open camera 0");
  }

  const std::string second =
      rpc("{\"id\":\"2\",\"method\":\"camera.start\","
                        "\"camera_index\":0}");
  if (!contains(second, "\"reopened\":false") || camera.startCalls != 1) {
    stopServer();
    fail("second camera.start was not idempotent");
  }

  (void)rpc("{\"id\":\"3\",\"method\":\"camera.stop\"}");
  const std::string stable =
      rpc("{\"id\":\"4\",\"method\":\"camera.start\","
                        "\"camera_index\":1,\"stable_key\":\"camera-a-key\"}");
  if (!contains(stable, "\"reopened\":true") || camera.startCalls != 2 ||
      camera.startedIndices.back() != 0) {
    stopServer();
    fail("stable_key did not take precedence over camera_index");
  }

  // Regression: switching to a not-yet-opened camera. camera.select moves the
  // program pointer without opening a session; camera.start must still OPEN the
  // target. The idempotency guard keys on activeCameraSet() (a live session),
  // not on the moved activeCameraIndex() alone — trusting the pointer made
  // start() short-circuit and left the switched-to camera (external webcams,
  // both platforms) black.
  (void)rpc("{\"id\":\"4a\",\"method\":\"camera.select\","
                          "\"camera_index\":1}");
  const std::string switched =
      rpc("{\"id\":\"4b\",\"method\":\"camera.start\","
                        "\"camera_index\":1}");
  if (!contains(switched, "\"reopened\":true") || camera.startCalls != 3 ||
      camera.startedIndices.back() != 1) {
    stopServer();
    fail("camera.start after select did not open the switched-to camera");
  }

  // Defensive: an index-less camera.start (fresh machine, setup page starting
  // before any selection, so activeCameraIndex() is -1 and no stable_key is
  // sent) must fall back to the first available camera instead of failing to a
  // black preview. A concrete-but-unresolvable stable_key stays a hard error
  // (covered by the program_select case below).
  (void)rpc("{\"id\":\"4c\",\"method\":\"camera.stop\"}");
  const std::string defaulted =
      rpc("{\"id\":\"4d\",\"method\":\"camera.start\"}");
  if (!contains(defaulted, "\"reopened\":true") ||
      camera.startedIndices.back() != 0) {
    stopServer();
    fail("index-less camera.start did not fall back to the first camera");
  }

  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.keyerMetrics.vcamPublishMs = 1.25;
    state.keyerMetrics.vcamPublishDropped = 7u;
#if defined(_WIN32)
    state.keyerMetrics.cameraUploadMs = 0.33;
    state.keyerMetrics.frameOverheadMs = 4.5;
    state.keyerMetrics.budgetThresholdMs = 18.0;
    state.keyerMetrics.prepassGpu = false;
#endif
    state.degradationStage = "no_subject";
  }
  const std::string keyer =
      rpc("{\"id\":\"5\",\"method\":\"keyer.get\"}");
  if (!contains(keyer, "\"vcam_publish_ms\":1.250000") ||
      !contains(keyer, "\"vcam_publish_dropped\":7") ||
      !contains(keyer, "\"empty_valid\":true") ||
      !contains(keyer, "\"no_subject\":true")) {
    stopServer();
    fail("keyer.get did not include vcam publish/no-subject fields");
  }
#if defined(_WIN32)
  if (!contains(keyer, "\"camera_upload_ms\":0.330000") ||
      !contains(keyer, "\"frame_overhead_ms\":4.500000") ||
      !contains(keyer, "\"budget_threshold_ms\":18.000000") ||
      !contains(keyer, "\"prepass_gpu\":false")) {
    stopServer();
    fail("keyer.get did not include Windows budget/upload metrics");
  }
#else
  if (contains(keyer, "\"camera_upload_ms\"") ||
      contains(keyer, "\"frame_overhead_ms\"") ||
      contains(keyer, "\"budget_threshold_ms\"") ||
      contains(keyer, "\"prepass_gpu\"")) {
    stopServer();
    fail("keyer.get changed macOS metric JSON");
  }
#endif

  const std::string keyerBackground = rpc("{\"id\":\"5a\",\"method\":\"keyer.configure\","
      "\"background_image_path\":\"/tmp/bg.png\","
      "\"background_asset_id\":\"a1\","
      "\"background_template_id\":\"t1\"}");
  if (!contains(keyerBackground, "\"background_image_set\":true") ||
      !contains(keyerBackground, "\"background_asset_id\":\"a1\"") ||
      !contains(keyerBackground, "\"background_template_id\":\"t1\"")) {
    stopServer();
    fail("keyer.configure did not surface background identity");
  }
  if (contains(keyerBackground, "/tmp/bg.png")) {
    stopServer();
    fail("keyer.get leaked background_image_path");
  }
  const std::string keyerTemplateClear = rpc("{\"id\":\"5b\",\"method\":\"keyer.configure\","
      "\"background_template_id\":null}");
  if (!contains(keyerTemplateClear, "\"background_asset_id\":\"a1\"") ||
      !contains(keyerTemplateClear, "\"background_template_id\":null")) {
    stopServer();
    fail("keyer.configure did not clear only the background template id");
  }
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.activeKeyer = "vision_person_segmentation";
  }
  const std::string keyerAssetChange = rpc("{\"id\":\"5c\",\"method\":\"keyer.configure\","
      "\"background_asset_id\":\"a2\"}");
  if (!contains(keyerAssetChange, "\"background_asset_id\":\"a2\"") ||
      !contains(keyerAssetChange, "\"background_template_id\":null") ||
      !contains(keyerAssetChange,
                "\"active_keyer\":\"vision_person_segmentation\"")) {
    stopServer();
    fail("background asset identity change reset active_keyer");
  }
  const std::string keyerReset =
      rpc("{\"id\":\"5d\",\"method\":\"keyer.reset\"}");
  if (!contains(keyerReset, "\"ok\":true")) {
    stopServer();
    fail("keyer.reset failed");
  }
  const std::string keyerAfterReset =
      rpc("{\"id\":\"5e\",\"method\":\"keyer.get\"}");
  if (!contains(keyerAfterReset, "\"background_image_set\":false") ||
      !contains(keyerAfterReset, "\"background_asset_id\":null") ||
      !contains(keyerAfterReset, "\"background_template_id\":null")) {
    stopServer();
    fail("keyer.reset did not clear background identity");
  }

  const std::string mediaPath = "C:\\Users\\J\303\266rg\\Decks\\page-02.png";
  const std::string mediaUpdate =
      rpc("{\"id\":\"6\",\"method\":\"program.update\","
                        "\"section\":\"media_layer\",\"values\":{"
                        "\"enabled\":true,\"render_status\":\"ready\","
                        "\"template_id\":\"tpl-1\","
                        "\"rendered_page_path\":\"C:\\\\Users\\\\J\\u00f6rg\\\\Decks\\\\page-02.png\","
                        "\"page\":2,\"page_count\":4,"
                        "\"x\":0.1,\"y\":0.2,\"width\":0.5,"
                        "\"height\":0.4,\"rotation\":5,"
                        "\"rotation_y\":-10}}");
  if (!contains(mediaUpdate, "\"ok\":true")) {
    stopServer();
    fail("media_layer update failed");
  }
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.mediaLayer.renderedPagePath != mediaPath) {
      stopServer();
      fail("rendered_page_path was not JSON-unescaped");
    }
  }

  // state.get carries the compact program summary + a monotonic
  // program_revision so other control clients can mirror "what is active".
  const std::string programState1 =
      rpc("{\"id\":\"6a\",\"method\":\"state.get\"}");
  if (!contains(programState1, "\"program\":") ||
      !contains(programState1, "\"program_revision\":") ||
      !contains(programState1, "\"media_layer\":{\"enabled\":true") ||
      !contains(programState1, "\"source\":\"page\"") ||
      !contains(programState1, "\"page\":2") ||
      !contains(programState1, "\"page_count\":4") ||
      !contains(programState1, "\"template_id\":\"tpl-1\"") ||
      !contains(programState1, "\"x\":0.1") ||
      !contains(programState1, "\"rotation_y\":-10") ||
      !contains(programState1, "\"render_status\":\"ready\"")) {
    stopServer();
    fail("state.get did not surface the program summary");
  }
  // Heavy fields must NOT be in the status push.
  if (contains(programState1, "rendered_page_path")) {
    stopServer();
    fail("state.get program summary leaked rendered_page_path");
  }

  const std::string mediaScreenUpdate =
      rpc("{\"id\":\"6s\",\"method\":\"program.update\","
                        "\"section\":\"media_layer\",\"values\":{"
                        "\"enabled\":true,\"mode\":\"pip\","
                        "\"source\":\"screen\"}}");
  const std::string mediaScreenState =
      rpc("{\"id\":\"6t\",\"method\":\"state.get\"}");
  const std::string mediaScreenRaw =
      rpc("{\"id\":\"6u\",\"method\":\"program.get\","
                        "\"section\":\"media_layer\"}");
  if (!contains(mediaScreenUpdate, "\"ok\":true") ||
      !contains(mediaScreenState, "\"source\":\"screen\"") ||
      !contains(mediaScreenRaw, "\"source\":\"screen\"")) {
    stopServer();
    fail("media_layer source=screen did not round-trip");
  }
  const std::string mediaBogusUpdate =
      rpc("{\"id\":\"6v\",\"method\":\"program.update\","
                        "\"section\":\"media_layer\",\"values\":{"
                        "\"enabled\":true,\"source\":\"bogus\"}}");
  const std::string mediaBogusState =
      rpc("{\"id\":\"6w\",\"method\":\"state.get\"}");
  if (!contains(mediaBogusUpdate, "\"ok\":true") ||
      !contains(mediaBogusState, "\"source\":\"page\"")) {
    stopServer();
    fail("media_layer bogus source did not normalize to page");
  }

  const std::string finiteUpdate =
      rpc("{\"id\":\"6aa\",\"method\":\"program.update\","
                        "\"section\":\"media_layer\",\"values\":{"
                        "\"enabled\":true,\"x\":1e999}}");
  if (!contains(finiteUpdate, "\"ok\":true")) {
    stopServer();
    fail("media_layer non-finite update failed");
  }
  const std::string programStateFinite =
      rpc("{\"id\":\"6ab\",\"method\":\"state.get\"}");
  if (!contains(programStateFinite, "\"x\":0") ||
      contains(programStateFinite, "inf")) {
    stopServer();
    fail("state.get emitted invalid JSON for non-finite media geometry");
  }

  // A cornerbug logo reports has_image=true but never the base64 image itself.
  const std::string logoUpdate = rpc("{\"id\":\"6b\",\"method\":\"program.update\",\"section\":\"cornerbug\","
      "\"values\":{\"enabled\":true,\"logo_asset_id\":\"logo-9\","
      "\"image_url\":\"https://x/y.png?token=abc\","
      "\"x\":0.8,\"image_data_url\":\"data:image/png;base64,AAAA\"}}");
  if (!contains(logoUpdate, "\"ok\":true")) {
    stopServer();
    fail("cornerbug update failed");
  }
  const std::string programState2 =
      rpc("{\"id\":\"6c\",\"method\":\"state.get\"}");
  if (!contains(programState2, "\"cornerbug\":{\"enabled\":true,\"has_image\":true") ||
      !contains(programState2, "\"logo_asset_id\":\"logo-9\"") ||
      !contains(programState2, "\"x\":0.8")) {
    stopServer();
    fail("state.get did not report cornerbug has_image");
  }
  if (contains(programState2, "image_data_url") ||
      contains(programState2, "base64") ||
      contains(programState2, "image_url") ||
      contains(programState2, "token=")) {
    stopServer();
    fail("state.get leaked the cornerbug image_data_url");
  }

  // camera.open_set resolves camera_stable_keys by device key, so a swapped
  // index order in camera_indices must not decide which cameras open.
  (void)rpc("{\"id\":\"7a\",\"method\":\"camera.stop\"}");
  const std::string openSet = rpc("{\"id\":\"7b\",\"method\":\"camera.open_set\",\"camera_indices\":[1,0],"
      "\"camera_stable_keys\":[\"camera-a-key\",\"camera-b-key\"]}");
  if (!contains(openSet, "\"ok\":true") ||
      camera.lastStartSetIndices != std::vector<int>{0, 1}) {
    stopServer();
    fail("open_set did not resolve camera_stable_keys by device key");
  }

  // Without stable keys the positional indices are used unchanged.
  (void)rpc("{\"id\":\"7c\",\"method\":\"camera.stop\"}");
  const std::string openSetIdx = rpc("{\"id\":\"7d\",\"method\":\"camera.open_set\",\"camera_indices\":[1,0]}");
  if (!contains(openSetIdx, "\"ok\":true") ||
      camera.lastStartSetIndices != std::vector<int>{1, 0}) {
    stopServer();
    fail("open_set without keys changed index behavior");
  }

  // program_select prefers stable_key over camera_index.
  const std::string programSelect = rpc("{\"id\":\"7e\",\"method\":\"camera.program_select\",\"camera_index\":0,"
      "\"stable_key\":\"camera-b-key\"}");
  if (!contains(programSelect, "\"ok\":true") ||
      camera.programSelectIndex != 1) {
    stopServer();
    fail("program_select did not prefer stable_key");
  }

  // An unknown stable_key is a clean error, not a silent wrong-camera cut.
  const std::string badProgram = rpc("{\"id\":\"7f\",\"method\":\"camera.program_select\","
      "\"stable_key\":\"missing-key\"}");
  if (!contains(badProgram, "camera_program_select_failed")) {
    stopServer();
    fail("program_select accepted an unknown stable_key");
  }

  // state.get surfaces the STICKY camera error (survives a camera list),
  // while last_error stays the live value. Decoupling is the whole point of
  // the sticky field: the UI must keep showing "camera stopped" after a scan.
  camera.stickyError = "device_removed (0x80070490)";
  camera.stickyErrorAtMs = 123456u;
  camera.liveError = "";  // e.g. just after a camera.list cleared the live one
  const std::string stateGet =
      rpc("{\"id\":\"7g\",\"method\":\"state.get\"}");
  if (!contains(stateGet,
                "\"camera_last_error\":\"device_removed (0x80070490)\"") ||
      !contains(stateGet, "\"camera_last_error_at\":123456") ||
      !contains(stateGet, "\"screen_capture\":{\"running\":false") ||
      !contains(stateGet, "\"captured_frames\":") ||
      !contains(stateGet, "\"title\":null") ||
      !contains(stateGet, "\"last_error\":null")) {
    stopServer();
    fail("state.get did not surface sticky camera error decoupled from last_error");
  }

  const std::string screenListUnsupported =
      rpc("{\"id\":\"8a\",\"method\":\"screen.list\"}");
  if (!contains(screenListUnsupported, "\"sources\":[") ||
      !contains(screenListUnsupported,
                "\"capabilities\":{\"supported\":false")) {
    stopServer();
    fail("screen.list did not return sources/capabilities shape");
  }
  const std::string screenStartUnsupported =
      rpc("{\"id\":\"8b\",\"method\":\"screen.start\","
              "\"source_id\":\"monitor:0x1\"}");
  if (!contains(screenStartUnsupported, "screen_capture_unsupported")) {
    stopServer();
    fail("screen.start without enumeration was not unsupported");
  }
  const std::string screenPickUnsupported =
      rpc("{\"id\":\"8c\",\"method\":\"screen.pick\"}");
  if (!contains(screenPickUnsupported, "screen_capture_unsupported")) {
    stopServer();
    fail("screen.pick without system picker was not unsupported");
  }
  const std::string screenStopIdle =
      rpc("{\"id\":\"8d\",\"method\":\"screen.stop\"}");
  if (!contains(screenStopIdle, "\"ok\":true")) {
    stopServer();
    fail("screen.stop was not idempotent");
  }

  screen.capabilitiesOverride.supported = true;
  screen.capabilitiesOverride.enumeration = true;
  screen.capabilitiesOverride.permissionStatus = "authorized";
  screen.capabilitiesOverride.unsupportedReason.clear();
  screen.knownSourceIds = {"monitor:0x1", "window:0x2"};
  const std::string screenList =
      rpc("{\"id\":\"8e\",\"method\":\"screen.list\"}");
  if (!contains(screenList, "\"source_id\":\"monitor:0x1\"") ||
      !contains(screenList, "\"capabilities\":{\"supported\":true")) {
    stopServer();
    fail("screen.list did not include known sources");
  }
  const std::string screenStart =
      rpc("{\"id\":\"8f\",\"method\":\"screen.start\","
              "\"source_id\":\"monitor:0x1\"}");
  if (!contains(screenStart, "\"ok\":true") ||
      !contains(screenStart, "\"source_id\":\"monitor:0x1\"") ||
      !contains(screenStart, "\"reopened\":false") ||
      screen.lastStartOptions.maxWidth != options.width ||
      screen.lastStartOptions.maxHeight != options.height ||
      screen.lastStartOptions.fps != options.fps ||
      !screen.lastStartOptions.includeCursor) {
    stopServer();
    fail("screen.start did not open known source with helper options");
  }
  const std::string screenReopen =
      rpc("{\"id\":\"8g\",\"method\":\"screen.start\","
              "\"source_id\":\"window:0x2\",\"include_cursor\":false}");
  if (!contains(screenReopen, "\"reopened\":true") ||
      screen.lastStartOptions.includeCursor) {
    stopServer();
    fail("screen.start did not mark different source as reopened");
  }
  const std::string screenUnknown =
      rpc("{\"id\":\"8h\",\"method\":\"screen.start\","
              "\"source_id\":\"monitor:0x9\"}");
  if (!contains(screenUnknown, "screen_source_not_found")) {
    stopServer();
    fail("screen.start accepted unknown source");
  }
  (void)rpc("{\"id\":\"8i\",\"method\":\"screen.stop\"}");
  screen.capabilitiesOverride.enumeration = false;
  const std::string screenNoEnumeration =
      rpc("{\"id\":\"8j\",\"method\":\"screen.start\","
              "\"source_id\":\"monitor:0x1\"}");
  if (!contains(screenNoEnumeration, "screen_capture_unsupported") ||
      !contains(screenNoEnumeration, "source_ids_unavailable_use_picker")) {
    stopServer();
    fail("screen.start without enumeration did not guide to picker");
  }

  screen.capabilitiesOverride.systemPicker = true;
  const std::string screenPick =
      rpc("{\"id\":\"8k\",\"method\":\"screen.pick\"}");
  const std::string screenPickBusy =
      rpc("{\"id\":\"8l\",\"method\":\"screen.pick\"}");
  if (!contains(screenPick, "\"picker_pending\":true") ||
      !contains(screenPickBusy, "screen_picker_busy")) {
    stopServer();
    fail("screen.pick did not return pending then busy");
  }

  (void)rpc("{\"id\":\"7\",\"method\":\"control.shutdown\"}");
  stopServer();
  std::cout << "control_server_test passed" << std::endl;
  return 0;
}
