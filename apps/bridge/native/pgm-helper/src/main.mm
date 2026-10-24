// Broadify Bridge PGM Helper: captures the switcher program (UVC now, DeckLink
// later), encodes with the hardware H.264 encoder and publishes it per WebRTC.
// Control: JSON-RPC over the helper-common line transport; lifecycle events on
// stdout and the sidecar event log (see docs/bridge/features/pgm-live-preview.md).
#include "common/pgm_options.h"
#include "control/pgm_rpc.h"
#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"
#include "helper_common/rpc_transport.h"
#include "macos/macos_app.h"
#include "pgm_engine.h"

#include <atomic>
#include <csignal>
#include <cstdio>
#include <future>
#include <iostream>
#include <thread>
#include <unistd.h>

namespace {

std::atomic<bool> g_running{true};

void signalHandler(int) { g_running.store(false); }

}  // namespace

int main(int argc, char **argv) {
  using namespace broadify::pgm;
  std::signal(SIGINT, signalHandler);
  std::signal(SIGTERM, signalHandler);
  // The bridge closing its RPC socket mid-write must not kill the helper.
  std::signal(SIGPIPE, SIG_IGN);

  PgmOptions options = parsePgmOptions(argc, argv);
  broadify::helper::setHelperEventLogPath(options.eventLogPath);
  setvbuf(stdout, nullptr, _IOLBF, 0);

  if (options.probe) {
    initializeMacosApplication();
    PgmEngine engine(PgmEngineConfig{});
    std::cout << "{\"type\":\"probe\",\"inputs\":" << engine.inputsListJson() << ",\"encoder\":\"videotoolbox\"}" << std::endl;
    return 0;
  }
  if (!options.run) {
    std::cerr << "pgm-helper requires --run" << std::endl;
    return 2;
  }
  if (options.controlSocket.empty()) {
    std::cerr << "pgm-helper requires --control-socket or PGM_CONTROL_SOCKET" << std::endl;
    return 2;
  }
  initializeMacosApplication();

  // Orphan watchdog: the helper app is launched through launchd (`open`), so
  // getppid() never points at the bridge; poll the PID the bridge passed.
  if (options.parentPid > 0) {
    const int bridgePid = options.parentPid;
    std::thread([bridgePid]() {
      while (g_running.load()) {
        std::this_thread::sleep_for(std::chrono::seconds(2));
        if (kill(bridgePid, 0) != 0) {
          broadify::helper::noteHelperExitReason("parent_gone");
          g_running.store(false);
        }
      }
    }).detach();
  }

  PgmEngineConfig config;
  config.syntheticSource = options.syntheticSource;
  config.logPerf = options.logPerf;
  PgmEngine engine(config);
  engine.start();

  std::promise<void> listening;
  std::future<void> listeningFuture = listening.get_future();
  broadify::helper::RpcTransportCallbacks callbacks;
  callbacks.handle = [&engine](const std::string &line) { return handlePgmRpc(line, engine, g_running); };
  callbacks.emitEvent = [](const std::string &jsonLine) { broadify::helper::emitHelperEvent(jsonLine); };
  callbacks.onListening = [&listening]() { listening.set_value(); };
  std::thread control([&]() { broadify::helper::runLineRpcServer(options.controlSocket, g_running, callbacks); });
  listeningFuture.wait();

  broadify::helper::emitHelperEvent("{\"type\":\"ready\",\"control_socket\":\"" + broadify::helper::jsonEscape(options.controlSocket) +
                                    "\",\"helper\":\"pgm\"}");

  runMacosApplicationLoop(g_running);

  engine.stop();
  control.join();
  const std::string reason = broadify::helper::helperExitReason();
  broadify::helper::emitHelperEvent("{\"type\":\"shutdown\",\"reason\":\"" + broadify::helper::jsonEscape(reason.empty() ? "signal" : reason) + "\"}");
  return 0;
}
