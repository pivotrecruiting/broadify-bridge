// Round-trips one request per connection through the shared transport and
// checks the shutdown path releases the endpoint. Stdlib + OS sockets only.
#include "helper_common/rpc_transport.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace {

void fail(const char *message) {
  std::cerr << "rpc_transport_test failed: " << message << std::endl;
  std::exit(1);
}

std::string uniqueEndpoint() {
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
#if defined(_WIN32)
  return "\\\\.\\pipe\\broadify-rpc-transport-test-" + std::to_string(stamp);
#else
  return "/tmp/broadify-rpc-transport-test-" + std::to_string(stamp) + ".sock";
#endif
}

std::string roundTrip(const std::string &endpoint, const std::string &line) {
#if defined(_WIN32)
  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (int attempt = 0; attempt < 50 && pipe == INVALID_HANDLE_VALUE; ++attempt) {
    pipe = CreateFileA(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) {
      Sleep(20);
    }
  }
  if (pipe == INVALID_HANDLE_VALUE) {
    fail("could not connect to pipe");
  }
  DWORD written = 0;
  WriteFile(pipe, line.c_str(), (DWORD)line.size(), &written, NULL);
  std::string response;
  char buffer[4096];
  DWORD readBytes = 0;
  while (ReadFile(pipe, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
    response.append(buffer, buffer + readBytes);
    if (response.find('\n') != std::string::npos) {
      break;
    }
  }
  CloseHandle(pipe);
  return response;
#else
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    fail("socket()");
  }
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", endpoint.c_str());
  if (connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
    fail("connect()");
  }
  if (write(fd, line.c_str(), line.size()) < 0) {
    fail("write()");
  }
  std::string response;
  char buffer[4096];
  ssize_t readBytes = 0;
  while ((readBytes = read(fd, buffer, sizeof(buffer))) > 0) {
    response.append(buffer, buffer + readBytes);
  }
  close(fd);
  return response;
#endif
}

}  // namespace

int main() {
  using broadify::helper::RpcTransportCallbacks;
  using broadify::helper::runLineRpcServer;

  const std::string endpoint = uniqueEndpoint();
  std::atomic<bool> running{true};
  std::mutex mutex;
  std::condition_variable listening;
  bool isListening = false;
  std::vector<std::string> events;
  std::vector<std::string> requests;

  RpcTransportCallbacks callbacks;
  callbacks.handle = [&](const std::string &line) {
    requests.push_back(line);
    return std::string("{\"ok\":true,\"echo\":\"") + line + "\"}\n";
  };
  callbacks.emitEvent = [&](const std::string &jsonLine) { events.push_back(jsonLine); };
  callbacks.onListening = [&]() {
    std::lock_guard<std::mutex> lock(mutex);
    isListening = true;
    listening.notify_all();
  };

  std::thread server([&]() { runLineRpcServer(endpoint, running, callbacks); });
  {
    std::unique_lock<std::mutex> lock(mutex);
    if (!listening.wait_for(lock, std::chrono::seconds(5), [&]() { return isListening; })) {
      fail("server never reported listening");
    }
  }

  const std::string first = roundTrip(endpoint, "{\"id\":\"1\",\"method\":\"control.ping\"}\n");
  if (first.find("\"echo\":\"{\\\"id\\\":\\\"1\\\"") == std::string::npos && first.find("control.ping") == std::string::npos) {
    fail("first response did not echo the request");
  }
  // Only the first line of a connection is served; a second request needs a
  // new connection (one request per connection contract).
  const std::string second = roundTrip(endpoint, "{\"id\":\"2\"}\nignored\n");
  if (second.find("\"id\\\":\\\"2") == std::string::npos && second.find("{\"id\":\"2\"}") == std::string::npos) {
    fail("second response did not echo the request");
  }
  if (requests.size() != 2 || requests[1] != "{\"id\":\"2\"}") {
    fail("handler saw unexpected request lines");
  }

  // Shutdown is request-driven in production (control.shutdown flips
  // `running` from inside the handler, then the loop exits after that
  // connection closes): accept()/ConnectNamedPipe block without a client, so
  // the test flips the flag and pokes the endpoint once, like the real helper.
  running.store(false);
  roundTrip(endpoint, "{\"id\":\"3\"}\n");
  server.join();
  if (requests.size() != 3) {
    fail("the shutdown poke was not served before the loop exited");
  }
  if (!events.empty()) {
    fail("unexpected transport events on the happy path");
  }
#if !defined(_WIN32)
  if (access(endpoint.c_str(), F_OK) == 0) {
    fail("socket file was not removed on shutdown");
  }
#endif
  std::cout << "rpc_transport_test passed" << std::endl;
  return 0;
}
