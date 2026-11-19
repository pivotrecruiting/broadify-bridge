// Windows side of platform_host.h (ADR-0009). Mirrors what
// meeting-helper/src/main.cpp does under _WIN32: console control handler,
// COM MTA + Media Foundation for the capture and encoder backends, parent
// watchdog on the bridge's process handle, UTF-8 arguments from the wide
// command line.

#if defined(_WIN32)

#include "platform/platform_host.h"

#include "helper_common/helper_event_log.h"
#include "helper_common/path_utf8.h"

#include <windows.h>

#include <mfapi.h>
#include <objbase.h>
#include <shellapi.h>

#include <chrono>
#include <csignal>
#include <cstdio>
#include <iostream>
#include <thread>

namespace broadify::pgm {
namespace {

std::atomic<bool> *g_running = nullptr;

void signalHandler(int) {
  if (g_running != nullptr) {
    g_running->store(false);
  }
}

// Ctrl+C / Ctrl+Break in a dev console, console close, logoff and shutdown.
// Runs on a thread the system creates; the main loop sees the flag and tears down.
BOOL WINAPI consoleCtrlHandler(DWORD) {
  if (g_running != nullptr) {
    g_running->store(false);
  }
  return TRUE;
}

}  // namespace

std::vector<std::string> processArgumentsUtf8(int argc, char **argv) {
  std::vector<std::string> args;
  int wideArgc = 0;
  LPWSTR *wideArgv = CommandLineToArgvW(GetCommandLineW(), &wideArgc);
  if (wideArgv != nullptr) {
    args.reserve(static_cast<size_t>(wideArgc > 0 ? wideArgc : 0));
    for (int i = 0; i < wideArgc; ++i) {
      args.push_back(broadify::helper::wideToUtf8(wideArgv[i]));
    }
    LocalFree(wideArgv);
    return args;
  }
  // CommandLineToArgvW failed (out of memory): fall back to the ANSI argv so
  // the helper still starts with its ASCII flags.
  args.reserve(static_cast<size_t>(argc > 0 ? argc : 0));
  for (int i = 0; i < argc; ++i) {
    args.emplace_back(argv[i] != nullptr ? argv[i] : "");
  }
  return args;
}

void installSignalHandlers(std::atomic<bool> &running) {
  g_running = &running;
  SetConsoleCtrlHandler(consoleCtrlHandler, TRUE);
  std::signal(SIGINT, signalHandler);
  std::signal(SIGTERM, signalHandler);
  // No SIGPIPE on Windows: a write to a closed pipe fails with an error code.
}

void configureStdoutForEvents() {
  // The Windows UCRT rejects setvbuf with line buffering and a zero-sized
  // buffer (invalid parameter -> fast-fail 0xC0000409). Unbuffered stdout; the
  // lifecycle events are low-volume and already flushed per line.
  setvbuf(stdout, nullptr, _IONBF, 0);
}

void initializePlatform() {
  // Main thread joins the MTA; capture and encoder threads initialize COM for
  // themselves. Media Foundation stays started for the process' lifetime (the
  // process exit releases it; there is no orderly MFShutdown path that could
  // run before the last backend thread is gone).
  const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com) && com != RPC_E_CHANGED_MODE) {
    std::cerr << "pgm-helper: CoInitializeEx failed (0x" << std::hex << static_cast<unsigned long>(com) << std::dec << ")" << std::endl;
  }
  const HRESULT mf = MFStartup(MF_VERSION);
  if (FAILED(mf)) {
    std::cerr << "pgm-helper: MFStartup failed (0x" << std::hex << static_cast<unsigned long>(mf) << std::dec << ")" << std::endl;
  }
}

void startParentWatchdog(int bridgePid, std::atomic<bool> &running) {
  // The bridge passes its PID via --parent-pid; when that process exits
  // (crash, hard kill, dev Ctrl+C) the helper shuts down instead of lingering
  // as an orphan holding the capture device.
  if (bridgePid <= 0) {
    return;
  }
  const DWORD pid = static_cast<DWORD>(bridgePid);
  std::atomic<bool> *runningPtr = &running;
  std::thread([pid, runningPtr]() {
    HANDLE handle = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (handle == nullptr) {
      return;
    }
    while (runningPtr->load()) {
      if (WaitForSingleObject(handle, 2000) == WAIT_OBJECT_0) {
        broadify::helper::noteHelperExitReason("parent_gone");
        runningPtr->store(false);
        break;
      }
    }
    CloseHandle(handle);
  }).detach();
}

void runPlatformLoop(std::atomic<bool> &running) {
  // MTA main thread: nothing to pump, only wait for the stop flag.
  while (running.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

std::string probeEncoderJson() { return "\"mediafoundation\""; }

}  // namespace broadify::pgm

#endif  // _WIN32
