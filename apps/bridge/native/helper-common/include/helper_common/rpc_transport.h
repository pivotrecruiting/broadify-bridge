#pragma once

#include <atomic>
#include <functional>
#include <string>

namespace broadify::helper {

/**
 * Line-oriented JSON-RPC server transport shared by the native helpers.
 *
 * One request per client connection: the client connects, sends one JSON line
 * (terminated by '\n'), receives one JSON line as the response, and the server
 * closes the connection. The transport is a Unix domain socket on POSIX and a
 * named pipe on Windows; the endpoint string is the socket path or pipe name.
 *
 * The loop runs on the calling thread until `running` turns false. It never
 * throws; setup failures are reported through `emitEvent` as JSON event lines
 * (codes: control_socket_failed, control_bind_failed, control_pipe_failed,
 * control_pipe_retry, control_write_failed) and the function returns.
 */
struct RpcTransportCallbacks {
  /** Handles one request line and returns the response line (incl. trailing '\n' if desired). */
  std::function<std::string(const std::string &line)> handle;
  /** Emits one JSON event line (stdout and/or sidecar log; chosen by the helper). */
  std::function<void(const std::string &jsonLine)> emitEvent;
  /** Called once the endpoint accepts connections (before the first accept). */
  std::function<void()> onListening;
};

void runLineRpcServer(const std::string &endpoint,
                      std::atomic<bool> &running,
                      const RpcTransportCallbacks &callbacks);

/**
 * Unblocks a server waiting in accept()/ConnectNamedPipe so it observes
 * `running == false`: connects to the endpoint once and closes. Call after
 * clearing the flag and before joining the server thread; without it a helper
 * whose bridge died lingers forever at the join (observed as orphan PGM
 * helpers on 2026-10-24).
 */
void wakeLineRpcServer(const std::string &endpoint);

}  // namespace broadify::helper
