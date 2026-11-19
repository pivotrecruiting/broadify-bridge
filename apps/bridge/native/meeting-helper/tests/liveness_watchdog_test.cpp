#include "capture/liveness_watchdog.h"

#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <thread>

using broadify::meeting::LivenessWatchdog;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "liveness_watchdog_test failed: " << what << std::endl;
  }
  return condition;
}

template <typename Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return predicate();
}

}  // namespace

int main() {
  bool ok = true;

  {
    std::atomic<int> lostCount{0};
    LivenessWatchdog watchdog(
        [] { return true; }, [&] { lostCount.fetch_add(1); },
        std::chrono::milliseconds(20));

    watchdog.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    ok &= expect(lostCount.load() == 0, "always-alive probe does not stop");

    const auto stopStart = std::chrono::steady_clock::now();
    watchdog.stop();
    const auto stopMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - stopStart)
                            .count();
    ok &= expect(stopMs < 200, "stop returns promptly");
    ok &= expect(!watchdog.running(), "running false after stop");
  }

  {
    std::atomic<int> probeCount{0};
    std::atomic<int> lostCount{0};
    LivenessWatchdog watchdog(
        [&] { return probeCount.fetch_add(1) < 2; },
        [&] { lostCount.fetch_add(1); }, std::chrono::milliseconds(20));

    watchdog.start();
    ok &= expect(waitUntil([&] { return lostCount.load() == 1; },
                           std::chrono::milliseconds(500)),
                 "loss callback fires");
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    ok &= expect(lostCount.load() == 1, "loss callback fires once");
    ok &= expect(waitUntil([&] { return !watchdog.running(); },
                           std::chrono::milliseconds(500)),
                 "thread ends after loss");
    watchdog.stop();
  }

  {
    std::atomic<int> lostCount{0};
    std::unique_ptr<LivenessWatchdog> watchdog;
    watchdog = std::make_unique<LivenessWatchdog>(
        [] { return false; },
        [&] {
          lostCount.fetch_add(1);
          watchdog->stop();
        },
        std::chrono::milliseconds(20));

    watchdog->start();
    ok &= expect(waitUntil([&] { return lostCount.load() == 1; },
                           std::chrono::milliseconds(500)),
                 "stop from onLost returns");
    ok &= expect(waitUntil([&] { return !watchdog->running(); },
                           std::chrono::milliseconds(500)),
                 "watchdog stopped after self-stop");
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    ok &= expect(lostCount.load() == 1, "self-stop loss callback fires once");
    watchdog.reset();
  }

  {
    std::atomic<int> lostCount{0};
    auto watchdog = std::make_unique<LivenessWatchdog>(
        [] { return true; }, [&] { lostCount.fetch_add(1); },
        std::chrono::milliseconds(20));

    watchdog->start();
    const auto destroyStart = std::chrono::steady_clock::now();
    watchdog.reset();
    const auto destroyMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - destroyStart)
            .count();
    ok &= expect(destroyMs < 300, "destructor stops promptly");
    ok &= expect(lostCount.load() == 0, "destructor does not report loss");
  }

  {
    std::atomic<int> lostCount{0};
    LivenessWatchdog watchdog(
        [] { return true; }, [&] { lostCount.fetch_add(1); },
        std::chrono::milliseconds(20));

    watchdog.start();
    watchdog.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    watchdog.stop();
    watchdog.stop();
    ok &= expect(lostCount.load() == 0, "repeated start/stop is harmless");
    ok &= expect(!watchdog.running(), "running false after repeated stop");
  }

  return ok ? 0 : 1;
}
