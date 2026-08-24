#include "control/control_server.h"
#include "preview/preview_frame_store.h"
#include "recorder/meeting_recorder.h"

#include <atomic>
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
using broadify::meeting::VideoFrame;
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
    return true;
  }

  void stop() override {
    running_ = false;
    activeIndex_ = -1;
  }

  bool isRunning() const override { return running_; }
  int activeCameraIndex() const override { return activeIndex_; }
  bool copyLatestFrame(VideoFrame &) override { return false; }
  std::string lastError() const override { return {}; }
  std::string cameraPermissionStatus() const override { return "authorized"; }
  std::string requestCameraPermission() override { return "authorized"; }

  int startCalls = 0;
  uint32_t lastWidth = 0;
  uint32_t lastHeight = 0;
  uint32_t lastFps = 0;
  std::vector<int> startedIndices;

 private:
  bool running_ = false;
  int activeIndex_ = -1;
};

#if defined(_WIN32)
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

  std::thread server([&] {
    runControlServer(endpoint, state, camera, previewFrames, recorder, options,
                     running, [&] {
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
      server.join();
      fail("server did not start");
    }
  }

  const std::string first =
      sendRpc(endpoint, "{\"id\":\"1\",\"method\":\"camera.start\","
                        "\"camera_index\":0}");
  if (!contains(first, "\"reopened\":true") || camera.startCalls != 1) {
    running.store(false);
    server.join();
    fail("first camera.start did not open camera 0");
  }

  const std::string second =
      sendRpc(endpoint, "{\"id\":\"2\",\"method\":\"camera.start\","
                        "\"camera_index\":0}");
  if (!contains(second, "\"reopened\":false") || camera.startCalls != 1) {
    running.store(false);
    server.join();
    fail("second camera.start was not idempotent");
  }

  (void)sendRpc(endpoint, "{\"id\":\"3\",\"method\":\"camera.stop\"}");
  const std::string stable =
      sendRpc(endpoint, "{\"id\":\"4\",\"method\":\"camera.start\","
                        "\"camera_index\":1,\"stable_key\":\"camera-a-key\"}");
  if (!contains(stable, "\"reopened\":true") || camera.startCalls != 2 ||
      camera.startedIndices.back() != 0) {
    running.store(false);
    server.join();
    fail("stable_key did not take precedence over camera_index");
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
      sendRpc(endpoint, "{\"id\":\"5\",\"method\":\"keyer.get\"}");
  if (!contains(keyer, "\"vcam_publish_ms\":1.250000") ||
      !contains(keyer, "\"vcam_publish_dropped\":7") ||
      !contains(keyer, "\"empty_valid\":true") ||
      !contains(keyer, "\"no_subject\":true")) {
    running.store(false);
    server.join();
    fail("keyer.get did not include vcam publish/no-subject fields");
  }
#if defined(_WIN32)
  if (!contains(keyer, "\"camera_upload_ms\":0.330000") ||
      !contains(keyer, "\"frame_overhead_ms\":4.500000") ||
      !contains(keyer, "\"budget_threshold_ms\":18.000000") ||
      !contains(keyer, "\"prepass_gpu\":false")) {
    running.store(false);
    server.join();
    fail("keyer.get did not include Windows budget/upload metrics");
  }
#else
  if (contains(keyer, "\"camera_upload_ms\"") ||
      contains(keyer, "\"frame_overhead_ms\"") ||
      contains(keyer, "\"budget_threshold_ms\"") ||
      contains(keyer, "\"prepass_gpu\"")) {
    running.store(false);
    server.join();
    fail("keyer.get changed macOS metric JSON");
  }
#endif

  const std::string mediaPath = "C:\\Users\\J\303\266rg\\Decks\\page-02.png";
  const std::string mediaUpdate =
      sendRpc(endpoint, "{\"id\":\"6\",\"method\":\"program.update\","
                        "\"section\":\"media_layer\",\"values\":{"
                        "\"enabled\":true,\"render_status\":\"ready\","
                        "\"rendered_page_path\":\"C:\\\\Users\\\\J\\u00f6rg\\\\Decks\\\\page-02.png\","
                        "\"page\":2,\"page_count\":4}}");
  if (!contains(mediaUpdate, "\"ok\":true")) {
    running.store(false);
    server.join();
    fail("media_layer update failed");
  }
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.mediaLayer.renderedPagePath != mediaPath) {
      running.store(false);
      server.join();
      fail("rendered_page_path was not JSON-unescaped");
    }
  }

  (void)sendRpc(endpoint, "{\"id\":\"7\",\"method\":\"control.shutdown\"}");
  server.join();
  std::cout << "control_server_test passed" << std::endl;
  return 0;
}
