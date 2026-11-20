// Broadify Bridge PGM Helper: captures the switcher program (UVC now, DeckLink
// later), encodes with the hardware H.264 encoder and publishes it per WebRTC.
// Control: JSON-RPC over the helper-common line transport; lifecycle events on
// stdout and the sidecar event log (see docs/bridge/features/pgm-live-preview.md).
#include "common/pgm_options.h"
#include "control/pgm_rpc.h"
#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"
#include "helper_common/rpc_transport.h"
#include "pgm_engine.h"
#include "platform/platform_host.h"

#include <atomic>
#include <future>
#include <iostream>
#include <thread>

namespace {

std::atomic<bool> g_running{true};

}  // namespace

// Portable entry point: everything the operating system has to provide sits
// behind platform/platform_host.h (signals, run loop, parent watchdog).
int main(int argc, char **argv) {
  using namespace broadify::pgm;
  installSignalHandlers(g_running);

  PgmOptions options = parsePgmOptions(processArgumentsUtf8(argc, argv));
  broadify::helper::setHelperEventLogPath(options.eventLogPath);
  configureStdoutForEvents();

  if (options.probe) {
    initializePlatform();
    PgmEngine engine(PgmEngineConfig{});
    const std::string encoderCandidates = probeEncoderCandidatesJson();
    std::cout << "{\"type\":\"probe\",\"inputs\":" << engine.inputsListJson() << ",\"encoder\":" << probeEncoderJson()
              << (encoderCandidates.empty() ? std::string() : ",\"encoder_candidates\":" + encoderCandidates) << "}" << std::endl;
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
  initializePlatform();

  // Orphan watchdog on the PID the bridge passed.
  startParentWatchdog(options.parentPid, g_running);

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

  runPlatformLoop(g_running);

  engine.stop();
  // The server blocks in accept(); poke it so it sees g_running == false (else the process lingers as an orphan).
  broadify::helper::wakeLineRpcServer(options.controlSocket);
  control.join();
  const std::string reason = broadify::helper::helperExitReason();
  broadify::helper::emitHelperEvent("{\"type\":\"shutdown\",\"reason\":\"" + broadify::helper::jsonEscape(reason.empty() ? "signal" : reason) + "\"}");
  return 0;
}
