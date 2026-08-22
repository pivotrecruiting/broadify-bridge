#include "capture/camera_source.h"
#include "common/options.h"
#include "control/control_server.h"
#include "compose/compositor.h"
#include "compose/d3d11_compositor.h"
#include "compose/gpu_context_win.h"
#include "compose/gpu_preprocess.h"
#include "keyer/matting_backend.h"
#include "keyer/modnet_keyer.h"
#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
#include "keyer/openvino_keyer.h"
#endif
#include "pipeline/frame_pipeline.h"
#include "preview/preview_frame_store.h"
#include "preview/mjpeg_server.h"
#include "preview/raw_frame_server.h"
#include "recorder/meeting_recorder.h"
#include "output/vcam_controller.h"
#include "state/meeting_state.h"
#include "util/helper_event_log.h"
#include "util/json_utils.h"
#include "util/win_qos.h"

#if defined(__APPLE__)
#include "macos/macos_app.h"
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <functional>
#include <numeric>
#include <vector>
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
#include <dbghelp.h>
#else
#include <unistd.h>
#endif

namespace broadify::meeting {
namespace {

std::atomic<bool> g_running{true};
// Which signal (if any) ended the main loop; read by the shutdown event so a
// SIGTERM-driven exit is distinguishable from a control_shutdown RPC.
std::atomic<int> g_exitSignal{0};

void signalHandler(int sig) {
  g_exitSignal.store(sig);
  g_running.store(false);
}

#if defined(_WIN32)
// Crash triage: unhandled SEH exceptions (access violations etc.) write a
// minidump next to the executable and log the faulting address before the
// process dies. WER LocalDumps needs admin rights, this does not.
LONG WINAPI writeCrashDump(EXCEPTION_POINTERS *pointers) {
  wchar_t modulePath[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, modulePath, MAX_PATH);
  std::wstring dumpPath(modulePath);
  const size_t slash = dumpPath.find_last_of(L'\\');
  dumpPath = dumpPath.substr(0, slash + 1) + L"meeting-helper-crash-" +
             std::to_wstring(GetCurrentProcessId()) + L".dmp";

  fprintf(stderr,
          "{\"type\":\"crash\",\"code\":\"0x%08lX\",\"address\":\"%p\"}\n",
          pointers->ExceptionRecord->ExceptionCode,
          pointers->ExceptionRecord->ExceptionAddress);

  // Symbolized stack of the crashing thread (PDB sits next to the exe in dev
  // builds). Best-effort: any failure just leaves the minidump as evidence.
  if (SymInitialize(GetCurrentProcess(), nullptr, TRUE)) {
    CONTEXT context = *pointers->ContextRecord;
    STACKFRAME64 frame{};
    frame.AddrPC.Offset = context.Rip;
    frame.AddrPC.Mode = AddrModeFlat;
    frame.AddrFrame.Offset = context.Rbp;
    frame.AddrFrame.Mode = AddrModeFlat;
    frame.AddrStack.Offset = context.Rsp;
    frame.AddrStack.Mode = AddrModeFlat;
    for (int depth = 0; depth < 24; ++depth) {
      if (!StackWalk64(IMAGE_FILE_MACHINE_AMD64, GetCurrentProcess(),
                       GetCurrentThread(), &frame, &context, nullptr,
                       SymFunctionTableAccess64, SymGetModuleBase64, nullptr) ||
          frame.AddrPC.Offset == 0) {
        break;
      }
      char symbolBuffer[sizeof(SYMBOL_INFO) + 256] = {};
      SYMBOL_INFO *symbol = reinterpret_cast<SYMBOL_INFO *>(symbolBuffer);
      symbol->SizeOfStruct = sizeof(SYMBOL_INFO);
      symbol->MaxNameLen = 255;
      DWORD64 displacement = 0;
      HMODULE module = nullptr;
      char moduleName[MAX_PATH] = "?";
      if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                 GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                             reinterpret_cast<LPCSTR>(frame.AddrPC.Offset),
                             &module)) {
        GetModuleFileNameA(module, moduleName, MAX_PATH);
      }
      if (SymFromAddr(GetCurrentProcess(), frame.AddrPC.Offset, &displacement,
                      symbol)) {
        fprintf(stderr, "  #%02d %s!%s+0x%llx\n", depth, moduleName,
                symbol->Name, static_cast<unsigned long long>(displacement));
      } else {
        fprintf(stderr, "  #%02d %s+0x%llx\n", depth, moduleName,
                static_cast<unsigned long long>(
                    frame.AddrPC.Offset -
                    reinterpret_cast<DWORD64>(module)));
      }
    }
  }
  fflush(stderr);

  HANDLE file = CreateFileW(dumpPath.c_str(), GENERIC_WRITE, 0, nullptr,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file != INVALID_HANDLE_VALUE) {
    MINIDUMP_EXCEPTION_INFORMATION info{};
    info.ThreadId = GetCurrentThreadId();
    info.ExceptionPointers = pointers;
    info.ClientPointers = FALSE;
    MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file,
                      MiniDumpWithIndirectlyReferencedMemory, &info, nullptr,
                      nullptr);
    CloseHandle(file);
  }
  return EXCEPTION_EXECUTE_HANDLER;
}
#endif

void printEvent(const std::string &json) {
  // Mirrored into the --event-log sidecar: on macOS the `open`-based launch
  // swallows stdout, so the sidecar is what the bridge can actually read.
  emitHelperEvent(json);
}

#if BROADIFY_ENABLE_MODNET
// Deterministic synthetic 1280x720 RGBA frame for the keyer self-test: a
// horizontal luminance gradient with a bright ellipse roughly where a head
// and torso would sit, so MODNet has foreground structure to segment.
VideoFrame makeKeyerSelfTestFrame() {
  VideoFrame frame;
  frame.width = 1280u;
  frame.height = 720u;
  frame.timestampNs = 1u;
  frame.rgba.resize(static_cast<size_t>(frame.width) * frame.height * 4u);
  const double centerX = 640.0;
  const double centerY = 430.0;
  const double radiusX = 200.0;
  const double radiusY = 280.0;
  for (uint32_t y = 0; y < frame.height; ++y) {
    for (uint32_t x = 0; x < frame.width; ++x) {
      const uint8_t gradient =
          static_cast<uint8_t>((static_cast<uint32_t>(x) * 160u) / frame.width);
      const double dx = (static_cast<double>(x) - centerX) / radiusX;
      const double dy = (static_cast<double>(y) - centerY) / radiusY;
      const bool insideEllipse = dx * dx + dy * dy <= 1.0;
      const size_t offset = (static_cast<size_t>(y) * frame.width + x) * 4u;
      frame.rgba[offset + 0u] = insideEllipse ? 235u : gradient;
      frame.rgba[offset + 1u] = insideEllipse ? 210u : gradient;
      frame.rgba[offset + 2u] = insideEllipse ? 190u : gradient;
      frame.rgba[offset + 3u] = 255u;
    }
  }
  return frame;
}

// Benchmarks one matting backend across the three input-size modes: run N
// timed inferences on the synthetic frame and print one JSON line per mode
// with mean/p95 latency (the "backend" and "provider" fields distinguish the
// sections). Returns false on any load/inference failure (fallbackActive
// counts as failure - a missing model must fail the self-test, not pass
// silently).
bool benchmarkKeyerBackend(
    const char *backendName, const VideoFrame &frame,
    const std::function<std::unique_ptr<Keyer>()> &makeKeyer) {
  constexpr int kRunsPerMode = 20;
  struct SizeMode {
    const char *performanceMode;
    uint32_t inputSize;
  };
  constexpr SizeMode kModes[] = {
      {"high_quality", 512u}, {"balanced", 320u}, {"performance", 256u}};
  bool ok = true;
  for (const SizeMode &mode : kModes) {
    // Fresh keyer per mode: macOS freezes the CoreML input shape when the
    // session is created, so a shared instance could not switch sizes.
    std::unique_ptr<Keyer> keyer = makeKeyer();
    KeyerSettings settings;
    settings.performanceMode = mode.performanceMode;
    std::vector<double> sampleMs;
    sampleMs.reserve(kRunsPerMode);
    KeyerStatus lastStatus;
    for (int run = 0; run < kRunsPerMode; ++run) {
      const KeyerResult result = keyer->apply(frame, settings);
      lastStatus = result.status;
      if (result.status.fallbackActive || result.mask.alpha.empty()) {
        // Load retries are throttled (30s backoff), further runs are futile.
        break;
      }
      sampleMs.push_back(result.status.inferenceMs);
    }
    if (sampleMs.empty()) {
      ok = false;
      std::ostringstream line;
      line << "{\"type\":\"keyer_self_test\",\"backend\":\"" << backendName
           << "\",\"provider\":\"" << jsonEscape(lastStatus.provider)
           << "\",\"input_size\":" << mode.inputSize << ",\"error\":\""
           << jsonEscape(lastStatus.fallbackReason) << "\"}";
      printEvent(line.str());
      continue;
    }
    const double meanMs =
        std::accumulate(sampleMs.begin(), sampleMs.end(), 0.0) /
        static_cast<double>(sampleMs.size());
    std::vector<double> sorted = sampleMs;
    std::sort(sorted.begin(), sorted.end());
    const size_t p95Index = static_cast<size_t>(
        std::ceil(0.95 * static_cast<double>(sorted.size()))) - 1u;
    std::ostringstream line;
    line << "{\"type\":\"keyer_self_test\",\"backend\":\"" << backendName
         << "\",\"provider\":\"" << jsonEscape(lastStatus.provider)
         << "\",\"input_size\":" << mode.inputSize
         << ",\"mean_ms\":" << meanMs << ",\"p95_ms\":" << sorted[p95Index]
         << ",\"probe_inference_ms\":" << lastStatus.probeInferenceMs << "}";
    printEvent(line.str());
  }
  return ok;
}

// Standalone keyer benchmark (--keyer-self-test). Always benchmarks the ONNX
// Runtime MODNet backend; with OpenVINO compiled in it benchmarks that
// backend as well, giving the A/B comparison (e.g. DirectML vs OpenVINO on an
// Intel iGPU) in one command. Exit 0 only when every benchmarked backend
// loaded and produced masks for every mode.
int runKeyerSelfTest(const Options &options) {
  const VideoFrame frame = makeKeyerSelfTestFrame();
  bool ok = benchmarkKeyerBackend("modnet", frame, [&options]() {
    return std::make_unique<ModnetKeyer>(ModnetKeyerOptions{options.modelsDir});
  });
#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
  {
    // OpenVINO A/B section. BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER=cpu
    // (the hardware-independent CI mode) pins the CPU device, mirroring how
    // the same env strips the DirectML provider above.
    std::string device = makeMattingBackendOptionsFromEnv(options.modelsDir).openVinoDevice;
    const char *selfTestProvider =
        std::getenv("BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER");
    if (selfTestProvider != nullptr && std::string(selfTestProvider) == "cpu") {
      device = "CPU";
    }
    const bool openVinoOk =
        benchmarkKeyerBackend("openvino_modnet", frame, [&options, &device]() {
          return std::make_unique<OpenVinoKeyer>(
              OpenVinoKeyerOptions{options.modelsDir, device, true});
        });
    ok = ok && openVinoOk;
  }
#endif
  std::ostringstream summary;
  summary << "{\"type\":\"keyer_self_test_summary\",\"ok\":"
          << (ok ? "true" : "false") << "}";
  printEvent(summary.str());
  return ok ? 0 : 1;
}
#endif  // BROADIFY_ENABLE_MODNET

int runGpuSelfTest() {
#if defined(_WIN32)
  if (!meetingGpuResidentEnabled()) {
    _putenv_s("BROADIFY_MEETING_GPU_RESIDENT", "1");
  }
  _putenv_s("BROADIFY_MEETING_GPU_SELF_TEST_DRIVER", "warp");
  const auto start = std::chrono::steady_clock::now();
  GpuContextWin &gpu = GpuContextWin::shared();
  const bool contextOk = gpu.available();
  bool fenceOk = false;
  bool preprocessOk = false;
  bool compositeOk = false;
  if (contextOk) {
    fenceOk = gpu.signalFromD3D11(1u) && gpu.waitOnD3D12(1u) &&
              gpu.signalFromD3D12(2u) && gpu.waitOnD3D11(2u);
    HANDLE fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (fenceEvent != nullptr &&
        SUCCEEDED(gpu.d3d12Fence()->SetEventOnCompletion(2u, fenceEvent))) {
      fenceOk = fenceOk &&
                WaitForSingleObject(fenceEvent, 2000u) == WAIT_OBJECT_0;
      CloseHandle(fenceEvent);
    } else {
      fenceOk = false;
    }
    constexpr uint32_t width = 1280u;
    constexpr uint32_t height = 720u;
    std::vector<uint8_t> nv12(static_cast<size_t>(width) * height * 3u / 2u,
                              128u);
    for (uint32_t y = 0; y < height; ++y) {
      for (uint32_t x = 0; x < width; ++x) {
        nv12[static_cast<size_t>(y) * width + x] =
            static_cast<uint8_t>((x * 180u) / width + 32u);
      }
    }
    D3D11_TEXTURE2D_DESC texDesc{};
    texDesc.Width = width;
    texDesc.Height = height;
    texDesc.MipLevels = 1;
    texDesc.ArraySize = 1;
    texDesc.Format = DXGI_FORMAT_NV12;
    texDesc.SampleDesc.Count = 1;
    texDesc.Usage = D3D11_USAGE_DEFAULT;
    texDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA initial{};
    initial.pSysMem = nv12.data();
    initial.SysMemPitch = width;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> cameraTexture;
    if (SUCCEEDED(gpu.d3d11Device()->CreateTexture2D(
            &texDesc, &initial, &cameraTexture))) {
      GpuPreprocessorWin preprocessor;
      GpuFrameSlot slot = gpu.frameRing().acquireNext();
      const uint32_t tensorSize = 256u;
      const ModnetLetterboxMapping letterbox =
          modnetLetterboxMapping(width, height, tensorSize, tensorSize);
      preprocessOk = preprocessor.preprocess(
          cameraTexture.Get(), 0u, GpuCameraFormat::Nv12, width, height,
          tensorSize, letterbox, slot);
    }
    VideoFrame frame = makeKeyerSelfTestFrame();
    AlphaMask mask;
    mask.width = frame.width;
    mask.height = frame.height;
    mask.timestampNs = frame.timestampNs;
    mask.alpha.assign(static_cast<size_t>(mask.width) * mask.height, 255u);
    CompositorSnapshot snapshot;
    snapshot.keyerEnabled = true;
    Options composeOptions;
    composeOptions.width = width;
    composeOptions.height = height;
    composeOptions.fps = 30u;
    std::vector<uint8_t> composited;
    renderProgramFrame(composeOptions, snapshot, &frame, &mask, nullptr, nullptr,
                       nullptr, 1u, composited);
    compositeOk = !composited.empty();
  }
  const auto end = std::chrono::steady_clock::now();
  const GpuContextTelemetry telemetry = currentGpuContextTelemetry();
  const double ms = std::chrono::duration<double, std::milli>(end - start).count();
  std::ostringstream out;
  out << "{\"ok\":" << (contextOk && fenceOk && preprocessOk && compositeOk ? "true" : "false")
      << ",\"stages\":{\"context\":" << (contextOk ? "true" : "false")
      << ",\"fence\":" << (fenceOk ? "true" : "false")
      << ",\"preprocess\":" << (preprocessOk ? "true" : "false")
      << ",\"dml\":\"skipped\""
      << ",\"composite\":" << (compositeOk ? "true" : "false")
      << "},\"ms\":" << ms
      << ",\"gpu_resident\":true"
      << ",\"d3d11_luid_high\":" << telemetry.d3d11LuidHigh
      << ",\"d3d11_luid_low\":" << telemetry.d3d11LuidLow
      << ",\"d3d12_luid_high\":" << telemetry.d3d12LuidHigh
      << ",\"d3d12_luid_low\":" << telemetry.d3d12LuidLow
      << ",\"cpu_frame_copies_per_frame\":0"
      << "}";
  printEvent(out.str());
  return contextOk && fenceOk && preprocessOk && compositeOk ? 0 : 1;
#else
  printEvent("{\"ok\":false,\"stages\":{\"context\":false},\"ms\":0,\"reason\":\"windows_only\"}");
  return 1;
#endif
}

}  // namespace
}  // namespace broadify::meeting

int main(int argc, char **argv) {
  using namespace broadify::meeting;

#if defined(_WIN32)
  SetUnhandledExceptionFilter(writeCrashDump);
  configureMeetingProcessQos();
#endif
  std::signal(SIGINT, signalHandler);
  std::signal(SIGTERM, signalHandler);
#if !defined(_WIN32)
  // A control-socket reply hitting a bridge-side-destroyed socket (RPC
  // timeout) raised SIGPIPE and killed the helper silently mid-meeting - the
  // control socket is the only one without SO_NOSIGPIPE. Ignore globally;
  // writes then fail with EPIPE and are logged instead of ending the process.
  std::signal(SIGPIPE, SIG_IGN);
#endif

  Options options = parseOptions(argc, argv);
  setHelperEventLogPath(options.eventLogPath);
  if (options.keyerSelfTest) {
    // Standalone benchmark used by scripts/test-meeting-helper.cjs (keyer /
    // keyer-hardware modes): no --run / --control-socket required.
#if BROADIFY_ENABLE_MODNET
    return runKeyerSelfTest(options);
#else
    // Built without ONNX Runtime (the default macOS build): report and fail
    // so CI never mistakes a keyer-less binary for a passing self-test.
    printEvent(
        "{\"type\":\"keyer_self_test_summary\",\"ok\":false,"
        "\"reason\":\"onnxruntime_disabled\"}");
    return 1;
#endif
  }
  if (options.gpuSelfTest) {
    return runGpuSelfTest();
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
  if (meetingGpuResidentEnabled()) {
    (void)GpuContextWin::shared().available();
  }
#endif

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
        noteHelperExitReason("parent_exited");
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
  const RawFrameStreamGeometry vcamGeometry{options.width, options.height, options.fps};
  std::thread vcamRaw(runRawFrameServer, options.vcamFramePort, vcamGeometry, std::ref(previewFrames), std::ref(state), std::ref(g_running));
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
  // Finalize an in-flight recording before exiting: std::_Exit below skips
  // destructors, and an unfinalized MP4 (no moov atom) is unplayable. This
  // runs after the frame pipeline has stopped, so no appendVideoFrame can
  // race the writer teardown. stop() is a no-op when nothing is recording.
  recorder.stop();
  // The preview/vcam/control servers block in accept() and never observe
  // g_running; joining them would hang forever (the historical reason this
  // helper survived every shutdown). Their sockets are closed by the OS.
  preview.detach();
  vcamRaw.detach();
  control.detach();
  // Name the exit path: silent code-0 exits were undiagnosable (the `open`
  // wrapper always reports 0 to the bridge whatever ended the app).
  std::string exitReason = helperExitReason();
  if (exitReason.empty()) {
    const int sig = g_exitSignal.load();
    exitReason = sig != 0 ? "signal_" + std::to_string(sig) : "main_loop_end";
  }
  printEvent("{\"type\":\"shutdown\",\"reason\":\"" + exitReason + "\"}");
  // std::_Exit also skips ALL static destructors — the frame pipeline's
  // FusedWarmupThreadHolder (frame_pipeline.cpp) DEPENDS on that: a fused
  // warmup thread still running at exit is detached and may still be using
  // the static fused keyer. Replacing std::_Exit with a normal return from
  // main would run those static destructors under the detached thread — a
  // shutdown use-after-free. Keep std::_Exit (or first join the warmup
  // thread via its busy flag) when changing this shutdown path.
  std::_Exit(0);
}
