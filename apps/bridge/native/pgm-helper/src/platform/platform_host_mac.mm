#include "platform/platform_host.h"

#include "helper_common/helper_event_log.h"
#include "macos/macos_app.h"

#include <chrono>
#include <csignal>
#include <cstdio>
#include <thread>
#include <unistd.h>

namespace broadify::pgm {
namespace {

std::atomic<bool> *g_running = nullptr;

void signalHandler(int) {
  if (g_running != nullptr) {
    g_running->store(false);
  }
}

}  // namespace

std::vector<std::string> processArgumentsUtf8(int argc, char **argv) {
  std::vector<std::string> args;
  args.reserve(static_cast<size_t>(argc > 0 ? argc : 0));
  for (int i = 0; i < argc; ++i) {
    args.emplace_back(argv[i] != nullptr ? argv[i] : "");
  }
  return args;
}

void installSignalHandlers(std::atomic<bool> &running) {
  g_running = &running;
  std::signal(SIGINT, signalHandler);
  std::signal(SIGTERM, signalHandler);
  // The bridge closing its RPC socket mid-write must not kill the helper.
  std::signal(SIGPIPE, SIG_IGN);
}

void configureStdoutForEvents() { setvbuf(stdout, nullptr, _IOLBF, 0); }

void initializePlatform() { initializeMacosApplication(); }

void startParentWatchdog(int bridgePid, std::atomic<bool> &running) {
  // The helper app is launched through launchd (`open`), so getppid() never
  // points at the bridge; poll the PID the bridge passed.
  if (bridgePid <= 0) {
    return;
  }
  std::atomic<bool> *runningPtr = &running;
  std::thread([bridgePid, runningPtr]() {
    while (runningPtr->load()) {
      std::this_thread::sleep_for(std::chrono::seconds(2));
      if (kill(bridgePid, 0) != 0) {
        broadify::helper::noteHelperExitReason("parent_gone");
        runningPtr->store(false);
      }
    }
  }).detach();
}

void runPlatformLoop(std::atomic<bool> &running) { runMacosApplicationLoop(running); }

std::string probeEncoderJson() { return "\"videotoolbox\""; }

// VideoToolbox picks its hardware encoder itself; there is no candidate list to report.
std::string probeEncoderCandidatesJson() { return ""; }

}  // namespace broadify::pgm
