#include "capture/camera_source.h"
#include "common/options.h"
#include "control/control_server.h"
#include "pipeline/frame_pipeline.h"
#include "preview/preview_frame_store.h"
#include "preview/mjpeg_server.h"
#include "preview/raw_frame_server.h"
#include "recorder/meeting_recorder.h"
#include "output/vcam_controller.h"
#include "state/meeting_state.h"
#include "util/json_utils.h"

#if defined(__APPLE__)
#include "macos/macos_app.h"
#endif

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <cstdlib>
#include <thread>
#include <chrono>
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

  std::promise<void> controlListening;
  std::future<void> controlListeningFuture = controlListening.get_future();
  // Parent watchdog: if the bridge dies without stopping us (crash, hard
  // kill, dev Ctrl+C), we get re-parented to PID 1 - shut down instead of
  // living on as an orphan in the user's process list.
#if !defined(_WIN32)
  // The bridge passes its PID via --parent-pid (the helper app is launched
  // through launchd, so getppid() never points at the bridge). Fall back to
  // the re-parenting check for direct spawns.
  const pid_t bridgePid = static_cast<pid_t>(options.parentPid);
  const pid_t initialParentPid = getppid();
  std::thread parentWatchdog([bridgePid, initialParentPid]() {
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
  });
  parentWatchdog.detach();
#endif

#if defined(_WIN32)
  // Windows parent watchdog: the bridge passes its PID via --parent-pid; when
  // that process exits (crash, hard kill, dev Ctrl+C) we shut down instead of
  // lingering as an orphan holding the camera and the virtual camera.
  if (options.parentPid > 0) {
    const DWORD bridgePid = static_cast<DWORD>(options.parentPid);
    std::thread parentWatchdog([bridgePid]() {
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
    });
    parentWatchdog.detach();
  }
#endif

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

  stopVirtualCamera();
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
