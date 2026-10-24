#include "helper_common/rpc_transport.h"

#include <cerrno>
#include <cstdio>
#include <string>

#if defined(_WIN32)
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace broadify::helper {
namespace {

constexpr size_t READ_BUFFER_BYTES = 8192;

void emit(const RpcTransportCallbacks &callbacks, const std::string &jsonLine) {
  if (callbacks.emitEvent) {
    callbacks.emitEvent(jsonLine);
  }
}

#if defined(_WIN32)

constexpr DWORD CONTROL_PIPE_BUFFER_BYTES = 65536;
// ~10 s of 50 ms retries before the control channel is declared dead.
constexpr int CONTROL_PIPE_CREATE_MAX_CONSECUTIVE_FAILURES = 200;
constexpr DWORD CONTROL_PIPE_CREATE_RETRY_DELAY_MS = 50;

// Creates one listening instance of the control pipe. CreateNamedPipeA can
// fail transiently (e.g. ERROR_PIPE_BUSY while libuv is still closing the
// previous client handle); a single such failure used to end the control
// thread for good while the helper process kept running - a silent, permanent
// ENOENT for every later bridge RPC. Retry with a bounded budget instead and
// report control_pipe_failed only once that budget is exhausted. Returns
// INVALID_HANDLE_VALUE after the final failure or when `running` turned false.
HANDLE createControlPipeInstance(const std::string &pipeName, std::atomic<bool> &running,
                                 const RpcTransportCallbacks &callbacks) {
  int consecutiveFailures = 0;
  while (running.load()) {
    HANDLE pipe = CreateNamedPipeA(pipeName.c_str(), PIPE_ACCESS_DUPLEX,
                                   PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                                   PIPE_UNLIMITED_INSTANCES, CONTROL_PIPE_BUFFER_BYTES,
                                   CONTROL_PIPE_BUFFER_BYTES, 0, NULL);
    if (pipe != INVALID_HANDLE_VALUE) {
      return pipe;
    }
    const DWORD lastError = GetLastError();
    consecutiveFailures += 1;
    if (consecutiveFailures >= CONTROL_PIPE_CREATE_MAX_CONSECUTIVE_FAILURES) {
      emit(callbacks,
           "{\"type\":\"error\",\"code\":\"control_pipe_failed\","
           "\"message\":\"Could not create control pipe.\",\"win32_error\":" +
               std::to_string(lastError) + ",\"attempts\":" + std::to_string(consecutiveFailures) + "}");
      return INVALID_HANDLE_VALUE;
    }
    emit(callbacks,
         "{\"type\":\"control_pipe_retry\",\"win32_error\":" + std::to_string(lastError) +
             ",\"attempt\":" + std::to_string(consecutiveFailures) + "}");
    Sleep(CONTROL_PIPE_CREATE_RETRY_DELAY_MS);
  }
  return INVALID_HANDLE_VALUE;
}

}  // namespace

void runLineRpcServer(const std::string &endpoint,
                      std::atomic<bool> &running,
                      const RpcTransportCallbacks &callbacks) {
  // Create the first instance BEFORE signalling readiness: the bridge starts
  // pinging as soon as it sees `ready`, and a pipe that does not exist yet is
  // indistinguishable (ENOENT) from a dead helper. If no instance can be
  // created the ready signal is withheld on purpose, so the bridge's start
  // timeout fires with control_pipe_failed as the visible cause.
  HANDLE pipe = createControlPipeInstance(endpoint, running, callbacks);
  if (pipe == INVALID_HANDLE_VALUE) {
    return;
  }
  if (callbacks.onListening) {
    callbacks.onListening();
  }
  while (running.load()) {
    BOOL connected = ConnectNamedPipe(pipe, NULL) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
    // Open the next instance before serving this client. With a single
    // instance there was a window between DisconnectNamedPipe/CloseHandle and
    // the next CreateNamedPipeA in which no pipe existed at all, and bridge
    // RPC bursts (engine start, status polls) hit ENOENT there - libuv retries
    // ERROR_PIPE_BUSY on its own but not ERROR_FILE_NOT_FOUND. RPC handling
    // stays sequential: the spare instance only parks the next client until
    // this loop comes back around.
    HANDLE nextPipe = createControlPipeInstance(endpoint, running, callbacks);
    if (connected) {
      char buffer[READ_BUFFER_BYTES];
      DWORD readBytes = 0;
      std::string pending;
      while (ReadFile(pipe, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
        pending.append(buffer, buffer + readBytes);
        size_t pos = pending.find('\n');
        if (pos != std::string::npos) {
          const std::string line = pending.substr(0, pos);
          const std::string response = callbacks.handle ? callbacks.handle(line) : std::string();
          DWORD written = 0;
          WriteFile(pipe, response.c_str(), (DWORD)response.size(), &written, NULL);
          // Block until the client has read the response; without this,
          // DisconnectNamedPipe below discards any unread data and the
          // client sees an empty reply (lost fast-command responses).
          FlushFileBuffers(pipe);
          break;
        }
      }
    }
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    if (nextPipe == INVALID_HANDLE_VALUE) {
      // Either shutting down (running == false) or control_pipe_failed was
      // already reported by createControlPipeInstance.
      return;
    }
    pipe = nextPipe;
  }
  // Loop left via control.shutdown: release the parked spare instance.
  CloseHandle(pipe);
}

#else

// Bounded receive timeout on the listening socket (inherited by accepted
// clients on some platforms): a client that connects and never sends a line
// cannot park the loop forever. Shutdown itself is request-driven: the
// handler flips `running` (control.shutdown) and the loop exits after that
// connection closes.
void configureSocketForShutdownChecks(int socketHandle) {
  timeval timeout{};
  timeout.tv_sec = 0;
  timeout.tv_usec = 250000;
  setsockopt(socketHandle, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&timeout), sizeof(timeout));
}

}  // namespace

void runLineRpcServer(const std::string &endpoint,
                      std::atomic<bool> &running,
                      const RpcTransportCallbacks &callbacks) {
  unlink(endpoint.c_str());
  int serverFd = static_cast<int>(socket(AF_UNIX, SOCK_STREAM, 0));
  if (serverFd < 0) {
    emit(callbacks, "{\"type\":\"error\",\"code\":\"control_socket_failed\",\"message\":\"Could not create control socket.\"}");
    return;
  }
  configureSocketForShutdownChecks(serverFd);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", endpoint.c_str());
  if (bind(serverFd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0 || listen(serverFd, 16) != 0) {
    emit(callbacks, "{\"type\":\"error\",\"code\":\"control_bind_failed\",\"message\":\"Could not bind control socket.\"}");
    close(serverFd);
    unlink(endpoint.c_str());
    return;
  }

  if (callbacks.onListening) {
    callbacks.onListening();
  }

  while (running.load()) {
    const int client = accept(serverFd, nullptr, nullptr);
    if (client < 0) {
      continue;
    }
    char buffer[READ_BUFFER_BYTES];
    std::string pending;
    ssize_t readBytes = 0;
    while ((readBytes = read(client, buffer, sizeof(buffer))) > 0) {
      pending.append(buffer, buffer + readBytes);
      const size_t pos = pending.find('\n');
      if (pos != std::string::npos) {
        const std::string line = pending.substr(0, pos);
        const std::string response = callbacks.handle ? callbacks.handle(line) : std::string();
        if (write(client, response.c_str(), response.size()) < 0) {
          // The bridge destroyed its socket first (RPC timeout). Before
          // SIGPIPE was ignored this write ended the whole process silently;
          // now it is a visible, non-fatal incident.
          emit(callbacks, "{\"type\":\"control_write_failed\",\"errno\":" + std::to_string(errno) + "}");
        }
        break;
      }
    }
    close(client);
  }
  close(serverFd);
  unlink(endpoint.c_str());
}

#endif

}  // namespace broadify::helper
