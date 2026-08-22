#include "capture/camera_source.h"
#include "common/options.h"
#include "control/control_server.h"
#include "keyer/matting_backend.h"
#include "keyer/modnet_keyer.h"
#if BROADIFY_ENABLE_OPENVINO && defined(_WIN32)
#include "keyer/openvino_keyer.h"
#endif
#include "pipeline/frame_pipeline.h"
#include "preview/preview_frame_store.h"
#include "preview/mjpeg_server.h"
#include "preview/raw_frame_server.h"
#include "preview/vcam_shm_ring_win.h"
#include "recorder/meeting_recorder.h"
#include "output/vcam_controller.h"
#include "state/meeting_state.h"
#include "util/helper_event_log.h"
#include "util/json_utils.h"
#include "util/win_qos.h"

#if defined(__APPLE__)
#include "macos/macos_app.h"
#endif
#if defined(_WIN32)
#include "build_stamp.h"
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
#include <cstring>
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <aclapi.h>
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

bool controlMappingAclGrantsLocalServiceWrite(const std::wstring &controlName) {
  HANDLE control = OpenFileMappingW(READ_CONTROL, FALSE, controlName.c_str());
  if (control == nullptr) {
    return false;
  }

  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PACL dacl = nullptr;
  const DWORD securityResult =
      GetSecurityInfo(control, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
                      nullptr, nullptr, &dacl, nullptr, &descriptor);
  CloseHandle(control);
  if (securityResult != ERROR_SUCCESS || dacl == nullptr) {
    if (descriptor != nullptr) {
      LocalFree(descriptor);
    }
    return false;
  }

  SID_IDENTIFIER_AUTHORITY ntAuthority = SECURITY_NT_AUTHORITY;
  PSID localServiceSid = nullptr;
  bool ok = false;
  if (AllocateAndInitializeSid(&ntAuthority, 1, SECURITY_LOCAL_SERVICE_RID, 0,
                               0, 0, 0, 0, 0, 0, &localServiceSid)) {
    for (DWORD i = 0; i < dacl->AceCount; ++i) {
      void *ace = nullptr;
      if (!GetAce(dacl, i, &ace)) {
        continue;
      }
      const auto *header = static_cast<const ACE_HEADER *>(ace);
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
        continue;
      }
      const auto *allowed = static_cast<const ACCESS_ALLOWED_ACE *>(ace);
      PSID sid = const_cast<DWORD *>(&allowed->SidStart);
      if (!EqualSid(sid, localServiceSid)) {
        continue;
      }
      const DWORD mask = allowed->Mask;
      const bool genericOk =
          (mask & (GENERIC_READ | GENERIC_WRITE)) ==
          (GENERIC_READ | GENERIC_WRITE);
      const bool sectionOk =
          (mask & (FILE_MAP_READ | FILE_MAP_WRITE)) ==
          (FILE_MAP_READ | FILE_MAP_WRITE);
      if (genericOk || sectionOk) {
        ok = true;
        break;
      }
    }
    FreeSid(localServiceSid);
  }
  LocalFree(descriptor);
  return ok;
}
#endif

void printEvent(const std::string &json) {
  // Mirrored into the --event-log sidecar: on macOS the `open`-based launch
  // swallows stdout, so the sidecar is what the bridge can actually read.
  emitHelperEvent(json);
}

std::string requestedVcamTransport() {
#if defined(_WIN32)
  const char *value = std::getenv("BROADIFY_MEETING_VCAM_TRANSPORT");
  if (value != nullptr && std::string(value) == "tcp") {
    return "tcp";
  }
  return "shm";
#else
  return "tcp";
#endif
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

std::wstring asciiToWide(const std::string &value) {
  return std::wstring(value.begin(), value.end());
}

int runVcamShmReaderSelfTest(const Options &options) {
#if defined(_WIN32)
  const uint32_t width = 64;
  const uint32_t height = 36;
  const size_t ringBytes =
      broadify::vcam_shm::ringBytesFor(width, height,
                                       broadify::vcam_shm::PixelFormat::Bgra8);
  const std::wstring controlName = asciiToWide(options.vcamShmSelfTestControlName);
  HANDLE control = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE,
                                    controlName.c_str());
  if (control == nullptr) {
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"reader_control_open\"}");
    return 1;
  }
  void *controlMemory = MapViewOfFile(
      control, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
      sizeof(broadify::vcam_shm::ControlRecord));
  if (controlMemory == nullptr) {
    CloseHandle(control);
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"reader_control_map\"}");
    return 1;
  }
  auto *controlRecord =
      static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory);
  broadify::vcam_shm::ControlRecord record;
  if (!broadify::vcam_shm::readControlRecord(*controlRecord, record)) {
    UnmapViewOfFile(controlMemory);
    CloseHandle(control);
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"reader_control_read\"}");
    return 1;
  }
  const std::wstring mappingName(record.mapping_name);
  const std::wstring eventName(record.event_name);
  HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mappingName.c_str());
  HANDLE event = OpenEventW(SYNCHRONIZE, FALSE, eventName.c_str());
  if (mapping == nullptr || event == nullptr) {
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"reader_open\"}");
    if (mapping != nullptr) CloseHandle(mapping);
    if (event != nullptr) CloseHandle(event);
    UnmapViewOfFile(controlMemory);
    CloseHandle(control);
    return 1;
  }
  void *memory = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, ringBytes);
  if (memory == nullptr) {
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"reader_map\"}");
    CloseHandle(event);
    CloseHandle(mapping);
    UnmapViewOfFile(controlMemory);
    CloseHandle(control);
    return 1;
  }
  LARGE_INTEGER mapQpc{};
  LARGE_INTEGER firstFrameQpc{};
  LARGE_INTEGER frequency{};
  QueryPerformanceCounter(&mapQpc);
  QueryPerformanceFrequency(&frequency);
  uint64_t lastSequence = 0;
  int frames = 0;
  const uint64_t deadline = GetTickCount64() + 5000u;
  while (GetTickCount64() < deadline && frames < 3) {
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    broadify::vcam_shm::updateReaderSlot(
        *controlRecord, GetCurrentProcessId(), static_cast<uint64_t>(now.QuadPart));
    WaitForSingleObject(event, 1000);
    broadify::vcam_shm::CopiedFrame frame;
    if (broadify::vcam_shm::copyNewestFrame(memory, ringBytes, frame) &&
        frame.sequence != lastSequence) {
      if (frames == 0) {
        QueryPerformanceCounter(&firstFrameQpc);
      }
      lastSequence = frame.sequence;
      ++frames;
    }
  }
  broadify::vcam_shm::clearReaderSlot(*controlRecord, GetCurrentProcessId());
  UnmapViewOfFile(memory);
  CloseHandle(event);
  CloseHandle(mapping);
  UnmapViewOfFile(controlMemory);
  CloseHandle(control);
  const uint64_t timeToFirstFrameMs =
      (frames > 0 && frequency.QuadPart > 0)
          ? static_cast<uint64_t>(((firstFrameQpc.QuadPart - mapQpc.QuadPart) *
                                   1000ll) /
                                  frequency.QuadPart)
          : UINT64_MAX;
  printEvent(std::string("{\"type\":\"vcam_shm_selftest\",\"role\":\"reader\",\"ok\":") +
             (frames == 3 ? "true" : "false") + ",\"frames\":" +
             std::to_string(frames) + ",\"time_to_first_frame_ms\":" +
             std::to_string(timeToFirstFrameMs) + "}");
  return frames == 3 ? 0 : 1;
#else
  (void)options;
  printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"reason\":\"windows_only\"}");
  return 1;
#endif
}

int runVcamShmSelfTest(const Options &options, const char *argv0) {
#if defined(_WIN32)
  VcamShmRingWin ring;
  const bool globalNamespace = !options.vcamShmSelfTestLocalNamespace;
  const std::wstring controlName =
      std::wstring(globalNamespace ? L"Global\\" : L"Local\\") +
      L"BroadifyVcamControlSelftest";
  const VcamShmCreateResult created =
      ring.createWithControlName(64, 36, 30, 1, controlName, globalNamespace);
  if (!created.ok || created.globalNamespace != globalNamespace) {
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"writer_create\"}");
    return 1;
  }
  if (globalNamespace && !controlMappingAclGrantsLocalServiceWrite(controlName)) {
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"control_acl\"}");
    return 1;
  }
  if (!globalNamespace) {
    std::vector<uint8_t> frame(64u * 36u * 4u, 90u);
    if (!ring.publishBgra(64, 36, frame.data(), frame.size(), 0u)) {
      printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"local_publish\"}");
      return 1;
    }
    HANDLE control = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE,
                                      controlName.c_str());
    if (control == nullptr) {
      printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"local_control_open\"}");
      return 1;
    }
    void *controlMemory = MapViewOfFile(
        control, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
        sizeof(broadify::vcam_shm::ControlRecord));
    if (controlMemory == nullptr) {
      CloseHandle(control);
      printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"local_control_map\"}");
      return 1;
    }
    auto *controlRecord =
        static_cast<broadify::vcam_shm::ControlRecord *>(controlMemory);
    broadify::vcam_shm::ControlRecord record;
    const bool controlOk =
        broadify::vcam_shm::readControlRecord(*controlRecord, record);
    HANDLE mapping = controlOk
                         ? OpenFileMappingW(FILE_MAP_READ, FALSE,
                                            std::wstring(record.mapping_name).c_str())
                         : nullptr;
    const size_t ringBytes =
        controlOk ? static_cast<size_t>(record.capacity_bytes) : 0u;
    void *memory = mapping == nullptr
                       ? nullptr
                       : MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, ringBytes);
    broadify::vcam_shm::CopiedFrame copied;
    const bool ok =
        memory != nullptr &&
        broadify::vcam_shm::copyNewestFrame(memory, ringBytes, copied) &&
        copied.data == frame;
    if (memory != nullptr) {
      UnmapViewOfFile(memory);
    }
    if (mapping != nullptr) {
      CloseHandle(mapping);
    }
    UnmapViewOfFile(controlMemory);
    CloseHandle(control);
    printEvent(std::string("{\"type\":\"vcam_shm_selftest\",\"role\":\"local\",\"ok\":") +
               (ok ? "true" : "false") + "}");
    return ok ? 0 : 1;
  }
  std::wstring command = L"\"";
  command += asciiToWide(argv0);
  command += L"\" --vcam-shm-reader-selftest ";
  command += controlName;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, 0,
                      nullptr, nullptr, &startup, &process)) {
    printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"stage\":\"spawn_reader\"}");
    return 1;
  }
  std::vector<uint8_t> frame(64u * 36u * 4u, 0);
  const uint64_t deadline = GetTickCount64() + 5000u;
  int frameIndex = 0;
  DWORD wait = WAIT_TIMEOUT;
  while (GetTickCount64() < deadline) {
    wait = WaitForSingleObject(process.hProcess, 0);
    if (wait == WAIT_OBJECT_0) {
      break;
    }
    std::memset(frame.data(), 40 + (frameIndex % 5) * 35, frame.size());
    ring.publishBgra(64, 36, frame.data(), frame.size(), 0u);
    ++frameIndex;
    Sleep(33);
  }
  if (wait != WAIT_OBJECT_0) {
    wait = WaitForSingleObject(process.hProcess, 0);
  }
  DWORD exitCode = 1;
  if (wait == WAIT_OBJECT_0) {
    GetExitCodeProcess(process.hProcess, &exitCode);
  } else {
    TerminateProcess(process.hProcess, 1);
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  printEvent(std::string("{\"type\":\"vcam_shm_selftest\",\"role\":\"writer\",\"ok\":") +
             (exitCode == 0 ? "true" : "false") + "}");
  return exitCode == 0 ? 0 : 1;
#else
  (void)options;
  (void)argv0;
  printEvent("{\"type\":\"vcam_shm_selftest\",\"ok\":false,\"reason\":\"windows_only\"}");
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
  if (options.vcamShmReaderSelfTest) {
    return runVcamShmReaderSelfTest(options);
  }
  if (options.vcamShmSelfTest) {
    return runVcamShmSelfTest(options, argc > 0 ? argv[0] : "meeting-helper.exe");
  }
#if defined(_WIN32)
  emitHelperEvent(std::string("{\"type\":\"meeting_helper_build\","
                              "\"git_sha\":\"") +
                  jsonEscape(BROADIFY_BUILD_GIT_SHA) +
                  "\",\"build_time\":\"" +
                  jsonEscape(BROADIFY_BUILD_TIMESTAMP) + "\"}");
#endif
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
  VcamShmRingWin vcamShm;
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

  std::string selectedVcamTransport = requestedVcamTransport();
#if defined(_WIN32)
  if (selectedVcamTransport == "tcp") {
    printEvent("{\"type\":\"meeting_vcam_raw\",\"event\":\"vcam_transport_selected\",\"transport\":\"tcp\",\"reason\":\"env\"}");
  }
#endif
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.vcamTransport = selectedVcamTransport;
  }
  setVirtualCameraTransport(selectedVcamTransport);

  std::thread frames(runFramePipeline, std::cref(options), std::ref(state), std::ref(*camera), std::ref(previewFrames), &vcamShm, std::ref(recorder), std::ref(g_running));
  std::thread preview(runMjpegServer, options.previewPort, std::ref(previewFrames), std::ref(state), std::ref(g_running));
  const RawFrameStreamGeometry vcamGeometry{options.width, options.height, options.fps};
  std::thread vcamRaw(runRawFrameServer, options.vcamFramePort, vcamGeometry, std::ref(previewFrames), std::ref(state), std::ref(g_running));
  std::thread vcamShmLifecycle([&options, &state, &vcamShm]() {
    int lastReaderCount = 0;
    uint64_t nextOpenAttemptMs = 0u;
    uint64_t lastReaderSeenMs = 0u;
    while (g_running.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      bool shouldUseShm = false;
      uint32_t width = options.width;
      uint32_t height = options.height;
      uint32_t fps = options.fps;
      uint64_t writerGeneration = 0u;
      {
        std::lock_guard<std::mutex> lock(state.mutex);
        shouldUseShm = state.vcamRawRunning && state.vcamTransport == "shm";
        writerGeneration = state.vcamWriterGeneration;
      }
      if (!shouldUseShm) {
        lastReaderSeenMs = 0u;
        continue;
      }
#if defined(_WIN32)
      if (!vcamShm.active()) {
        const uint64_t now = GetTickCount64();
        if (now < nextOpenAttemptMs) {
          continue;
        }
        if (writerGeneration == 0u) {
          writerGeneration = initialVcamWriterGeneration();
          std::lock_guard<std::mutex> lock(state.mutex);
          if (state.vcamWriterGeneration == 0u) {
            state.vcamWriterGeneration = writerGeneration;
          } else {
            writerGeneration = state.vcamWriterGeneration;
          }
        } else {
          ++writerGeneration;
          std::lock_guard<std::mutex> lock(state.mutex);
          state.vcamWriterGeneration = writerGeneration;
        }
        const VcamShmCreateResult opened =
            vcamShm.create(width, height, fps, writerGeneration);
        if (opened.ok) {
          setVirtualCameraTransport("shm");
          printEvent("{\"type\":\"meeting_vcam_raw\",\"event\":\"vcam_transport_selected\",\"transport\":\"shm\",\"reason\":\"" +
                     jsonEscape(opened.reason.empty() ? "opened_service_ring"
                                                      : opened.reason) +
                     "\"}");
          nextOpenAttemptMs = 0u;
          lastReaderSeenMs = now;
        } else {
          setVirtualCameraTransport("tcp");
          nextOpenAttemptMs = now + 2000u;
        }
        continue;
      }
#endif
      vcamShm.heartbeat(0u);
      const int readerCount =
          static_cast<int>(std::min<uint64_t>(vcamShm.readerCount(), 32u));
#if defined(_WIN32)
      const uint64_t nowMs = GetTickCount64();
#else
      const uint64_t nowMs = 0u;
#endif
      if (readerCount > 0) {
        lastReaderSeenMs = nowMs;
      } else if (lastReaderSeenMs != 0u && nowMs >= lastReaderSeenMs + 5000u &&
                 vcamShm.readerHeartbeatAbsent(5000u)) {
        vcamShm.close();
        lastReaderSeenMs = 0u;
        nextOpenAttemptMs = 0u;
        continue;
      }
      if (readerCount != lastReaderCount) {
        std::lock_guard<std::mutex> lock(state.mutex);
        state.vcamShmReaderCount = readerCount;
        state.vcamClientCount =
            state.vcamShmReaderCount + state.vcamTcpClientCount;
        state.programDirty = true;
        ++state.programRevision;
        lastReaderCount = readerCount;
      }
    }
  });
  std::thread control(
      runControlServer,
      options.controlSocket,
      std::ref(state),
      std::ref(*camera),
      std::ref(previewFrames),
      std::ref(recorder),
      std::cref(options),
      std::ref(g_running),
      [&controlListening]() { controlListening.set_value(); },
      &vcamShm);

  controlListeningFuture.wait();

  std::ostringstream ready;
  ready << "{\"type\":\"ready\",\"framebus\":\"" << jsonEscape(options.framebusName)
        << "\",\"preview_port\":" << options.previewPort
        << ",\"vcam_frame_port\":" << options.vcamFramePort
        << ",\"vcam_transport\":\"" << jsonEscape(selectedVcamTransport) << "\""
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
  if (vcamRaw.joinable()) {
    vcamRaw.detach();
  }
  if (vcamShmLifecycle.joinable()) {
    vcamShmLifecycle.detach();
  }
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
