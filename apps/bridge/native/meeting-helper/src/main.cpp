#include "capture/camera_source.h"
#include "common/options.h"
#include "control/control_server.h"
#include "pipeline/frame_pipeline.h"
#include "preview/preview_frame_store.h"
#include "preview/mjpeg_server.h"
#include "preview/raw_frame_server.h"
#include "state/meeting_state.h"
#include "util/json_utils.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <future>
#include <iostream>
#include <memory>
#include <sstream>
#include <thread>

namespace broadify::meeting {
namespace {

std::atomic<bool> g_running{true};

void signalHandler(int) {
  g_running.store(false);
}

void printEvent(const std::string &json) {
  std::cout << json << std::endl;
}

}  // namespace
}  // namespace broadify::meeting

int main(int argc, char **argv) {
  using namespace broadify::meeting;

  std::signal(SIGINT, signalHandler);
  std::signal(SIGTERM, signalHandler);

  Options options = parseOptions(argc, argv);
  if (!options.run) {
    std::cerr << "meeting-helper requires --run" << std::endl;
    return 2;
  }
  if (options.controlSocket.empty()) {
    std::cerr << "meeting-helper requires --control-socket or MEETING_CONTROL_SOCKET" << std::endl;
    return 2;
  }

  // stdout is piped to the bridge; ensure lifecycle events flush promptly.
  setvbuf(stdout, nullptr, _IOLBF, 0);

  MeetingState state;
  std::unique_ptr<CameraSource> camera = createCameraSource();
  PreviewFrameStore previewFrames;

  std::promise<void> controlListening;
  std::future<void> controlListeningFuture = controlListening.get_future();
  std::thread frames(runFramePipeline, std::cref(options), std::ref(state), std::ref(*camera), std::ref(previewFrames), std::ref(g_running));
  std::thread preview(runMjpegServer, options.previewPort, std::ref(previewFrames), std::ref(g_running));
  std::thread vcamRaw(runRawFrameServer, options.vcamFramePort, std::ref(previewFrames), std::ref(g_running));
  std::thread control(
      runControlServer,
      options.controlSocket,
      std::ref(state),
      std::ref(*camera),
      std::cref(options),
      std::ref(g_running),
      [&controlListening]() { controlListening.set_value(); });

  controlListeningFuture.wait();

  std::ostringstream ready;
  ready << "{\"type\":\"ready\",\"framebus\":\"" << jsonEscape(options.framebusName)
        << "\",\"preview_port\":" << options.previewPort
        << ",\"vcam_frame_port\":" << options.vcamFramePort
        << ",\"control_socket\":\"" << jsonEscape(options.controlSocket) << "\"}";
  printEvent(ready.str());

  uint64_t tick = 0;
  while (g_running.load()) {
    std::this_thread::sleep_for(std::chrono::seconds(2));
    std::ostringstream metrics;
    metrics << "{\"type\":\"metrics\",\"fps\":" << options.fps
            << ",\"keyer\":\"passthrough\",\"inference_ms\":null,\"drops\":0,\"tick\":" << tick++ << "}";
    printEvent(metrics.str());
  }

  camera->stop();
  if (frames.joinable()) {
    frames.join();
  }
  if (preview.joinable()) {
    preview.detach();
  }
  if (vcamRaw.joinable()) {
    vcamRaw.detach();
  }
  if (control.joinable()) {
    control.detach();
  }
  return 0;
}
