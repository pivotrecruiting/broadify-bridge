#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>

namespace broadify::meeting {

class LivenessWatchdog {
 public:
  using Probe = std::function<bool()>;
  using OnLost = std::function<void()>;

  LivenessWatchdog(Probe probe, OnLost onLost,
                   std::chrono::milliseconds interval);
  ~LivenessWatchdog();

  void start();
  void stop();
  bool running() const;

 private:
  struct State;

  std::shared_ptr<State> state_;
  mutable std::mutex threadMutex_;
  std::thread thread_;
};

}  // namespace broadify::meeting
