#include "capture/camera_source.h"
#include "common/options.h"
#include "compose/compositor.h"
#include "control/control_server.h"
#include "keyer/keyer_chain.h"
#include "pipeline/frame_pipeline.h"
#include "preview/preview_frame_store.h"
#include "preview/mjpeg_server.h"
#include "preview/raw_frame_server.h"
#include "recorder/meeting_recorder.h"
#include "state/meeting_state.h"
#include "util/json_utils.h"

#if defined(__APPLE__)
#include "macos/macos_app.h"
#endif

#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

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
  if (options.selfTest) {
    const GpuCompositorSelfTestResult result = runGpuCompositorSelfTest();
#if defined(__APPLE__)
    const bool expectedAcceleration = true;
#elif defined(_WIN32)
    const char *selfTestDriver =
        std::getenv("BROADIFY_MEETING_GPU_SELF_TEST_DRIVER");
    const bool expectedAcceleration =
        selfTestDriver == nullptr || std::strcmp(selfTestDriver, "warp") != 0;
#else
    const bool expectedAcceleration = false;
#endif
    const bool modeMatches =
        result.hardwareAccelerated == expectedAcceleration;
    const bool passed = result.passed && modeMatches;
    std::cout << "{\"type\":\"meeting_gpu_self_test\",\"backend\":\""
              << result.backend << "\",\"available\":"
              << (result.available ? "true" : "false") << ",\"passed\":"
              << (passed ? "true" : "false")
              << ",\"hardware_accelerated\":"
              << (result.hardwareAccelerated ? "true" : "false")
              << ",\"mode_matches\":"
              << (modeMatches ? "true" : "false")
              << ",\"max_channel_delta\":"
              << result.maxChannelDelta << ",\"max_delta_x\":"
              << result.maxDeltaX << ",\"max_delta_y\":" << result.maxDeltaY
              << ",\"max_delta_channel\":" << result.maxDeltaChannel
              << ",\"max_delta_cpu_value\":"
              << static_cast<uint32_t>(result.maxDeltaCpuValue)
              << ",\"max_delta_gpu_value\":"
              << static_cast<uint32_t>(result.maxDeltaGpuValue) << "}" << std::endl;
    return passed ? 0 : 3;
  }
  if (options.keyerSelfTest) {
    MeetingState state;
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.keyerEnabled = true;
      state.requestedKeyerModel = "modnet";
      state.performanceMode = "performance";
    }
    VideoFrame frame;
    frame.width = 640u;
    frame.height = 360u;
    frame.timestampNs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
    frame.rgba.assign(static_cast<size_t>(frame.width) * frame.height * 4u, 255u);
    for (uint32_t y = 0; y < frame.height; ++y) {
      for (uint32_t x = 0; x < frame.width; ++x) {
        const size_t offset = (static_cast<size_t>(y) * frame.width + x) * 4u;
        frame.rgba[offset + 0u] = static_cast<uint8_t>((x * 255u) / frame.width);
        frame.rgba[offset + 1u] = static_cast<uint8_t>((y * 255u) / frame.height);
        frame.rgba[offset + 2u] = 96u;
      }
    }
    KeyerChain keyer(options);
    const KeyerResult result = keyer.process(frame, state);
#if defined(__APPLE__)
    const bool acceleratedProvider = result.status.provider == "coreml";
#elif defined(_WIN32)
    const bool acceleratedProvider = result.status.provider == "directml";
    const char *selfTestProvider =
        std::getenv("BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER");
    const bool forceCpuProvider =
        selfTestProvider != nullptr &&
        std::strcmp(selfTestProvider, "cpu") == 0;
    const bool acceptedProvider = forceCpuProvider
        ? result.status.provider == "cpu"
        : acceleratedProvider;
#else
    const bool acceleratedProvider = false;
#endif
#if !defined(_WIN32)
    const bool acceptedProvider = acceleratedProvider;
#endif
    const bool passed = acceptedProvider && result.status.modelHashOk &&
        !result.status.fallbackActive && !result.mask.alpha.empty();
    std::cout << "{\"type\":\"meeting_keyer_self_test\",\"provider\":\""
              << result.status.provider << "\",\"active_keyer\":\""
              << result.status.activeKeyer << "\",\"fallback_active\":"
              << (result.status.fallbackActive ? "true" : "false")
              << ",\"hardware_accelerated\":"
              << (acceleratedProvider ? "true" : "false")
              << ",\"fallback_reason\":\"" << result.status.fallbackReason
              << "\",\"model_hash_ok\":"
              << (result.status.modelHashOk ? "true" : "false")
              << ",\"mask_width\":" << result.mask.width
              << ",\"mask_height\":" << result.mask.height
              << ",\"passed\":" << (passed ? "true" : "false") << "}"
              << std::endl;
    return passed ? 0 : 4;
  }
  if (!options.run) {
    std::cerr << "meeting-helper requires --run" << std::endl;
    return 2;
  }
  if (options.controlSocket.empty()) {
    std::cerr << "meeting-helper requires --control-socket or MEETING_CONTROL_SOCKET" << std::endl;
    return 2;
  }

  // stdout is piped to the bridge; ensure lifecycle events flush promptly.
#if defined(_WIN32)
  // The Windows UCRT rejects setvbuf with _IOLBF and a zero-sized buffer
  // (invalid parameter -> fast-fail 0xC0000409). Use unbuffered stdout; the
  // lifecycle events are low-volume and already flushed per line.
  setvbuf(stdout, nullptr, _IONBF, 0);
#else
  setvbuf(stdout, nullptr, _IOLBF, 0);
#endif

#if defined(__APPLE__)
  initializeMacosApplication();
#endif

  MeetingState state;
  std::unique_ptr<CameraSource> camera = createCameraSource();
  PreviewFrameStore previewFrames;
  MeetingRecorder recorder;

#if defined(_WIN32)
  if (options.parentPid > 0) {
    const DWORD bridgePid = static_cast<DWORD>(options.parentPid);
    std::thread([bridgePid]() {
      HANDLE handle = OpenProcess(SYNCHRONIZE, FALSE, bridgePid);
      if (handle == nullptr) {
        return;
      }
      while (g_running.load()) {
        if (WaitForSingleObject(handle, 2000) == WAIT_OBJECT_0) {
          g_running.store(false);
          break;
        }
      }
      CloseHandle(handle);
    }).detach();
  }
#else
  const pid_t bridgePid = static_cast<pid_t>(options.parentPid);
  const pid_t initialParentPid = getppid();
  std::thread([bridgePid, initialParentPid]() {
    while (g_running.load()) {
      const bool bridgeGone = bridgePid > 0
          ? (kill(bridgePid, 0) != 0 && errno == ESRCH)
          : (getppid() != initialParentPid);
      if (bridgeGone) {
        g_running.store(false);
        break;
      }
      std::this_thread::sleep_for(std::chrono::seconds(2));
    }
  }).detach();
#endif

  std::promise<void> controlListening;
  std::future<void> controlListeningFuture = controlListening.get_future();
  std::thread frames(runFramePipeline, std::cref(options), std::ref(state), std::ref(*camera), std::ref(previewFrames), std::ref(recorder), std::ref(g_running));
  std::thread preview(runMjpegServer, options.previewPort, std::ref(previewFrames), std::ref(state), std::ref(g_running));
  std::thread vcamRaw(runRawFrameServer, options.vcamFramePort, std::ref(previewFrames), std::ref(state), std::ref(g_running));
  std::thread control(
      runControlServer,
      options.controlSocket,
      std::ref(state),
      std::ref(*camera),
      std::ref(previewFrames),
      std::ref(recorder),
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

#if defined(__APPLE__)
  runMacosApplicationLoop(g_running);
#else
  uint64_t tick = 0;
  while (g_running.load()) {
    std::this_thread::sleep_for(std::chrono::seconds(2));
    std::ostringstream metrics;
    metrics << "{\"type\":\"metrics\",\"fps\":" << options.fps
            << ",\"keyer\":\"passthrough\",\"inference_ms\":null,\"drops\":0,\"tick\":" << tick++ << "}";
    printEvent(metrics.str());
  }
#endif

  camera->stop();
  previewFrames.clear();
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.framebusRunning = false;
    state.vcamRawRunning = false;
  }
  // The frame pipeline checks g_running and releases the FrameBus shared
  // memory on its way out - wait for it.
  if (frames.joinable()) {
    frames.join();
  }
  // The preview/vcam/control servers block in accept() and never observe
  // g_running; joining them would hang forever (the historical reason this
  // helper survived every shutdown). Their sockets are closed by the OS.
  preview.detach();
  vcamRaw.detach();
  control.detach();
  printEvent("{\"type\":\"shutdown\"}");
  std::_Exit(0);
}
