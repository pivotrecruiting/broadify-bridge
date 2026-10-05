#include "capture/liveness_watchdog.h"

#include <algorithm>
#include <utility>

namespace broadify::meeting {
namespace {

constexpr auto kMaxStopSleep = std::chrono::milliseconds(50);
constexpr auto kMinInterval = std::chrono::milliseconds(1);

}  // namespace

struct LivenessWatchdog::State {
  Probe probe;
  OnLost onLost;
  std::chrono::milliseconds interval;
  std::atomic<bool> stopRequested{false};
  std::atomic<bool> running{false};
  std::atomic<bool> onLostCalled{false};
  std::mutex mutex;
  std::thread::id threadId;
};

LivenessWatchdog::LivenessWatchdog(Probe probe, OnLost onLost,
                                   std::chrono::milliseconds interval)
    : state_(std::make_shared<State>()) {
  state_->probe = std::move(probe);
  state_->onLost = std::move(onLost);
  state_->interval = interval > std::chrono::milliseconds::zero()
                         ? interval
                         : kMinInterval;
}

LivenessWatchdog::~LivenessWatchdog() {
  stop();
}

void LivenessWatchdog::start() {
  std::lock_guard<std::mutex> lock(threadMutex_);
  if (thread_.joinable() || state_->running.load()) {
    return;
  }

  state_->stopRequested.store(false);
  state_->onLostCalled.store(false);
  state_->running.store(true);
  auto state = state_;
  try {
    thread_ = std::thread([state]() {
      {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->threadId = std::this_thread::get_id();
      }

      auto nextProbe = std::chrono::steady_clock::now() + state->interval;
      while (!state->stopRequested.load()) {
        const auto now = std::chrono::steady_clock::now();
        if (now < nextProbe) {
          const auto remaining =
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  nextProbe - now);
          std::this_thread::sleep_for(
              std::max(kMinInterval, std::min(kMaxStopSleep, remaining)));
          continue;
        }

        bool alive = true;
        try {
          alive = state->probe ? state->probe() : false;
        } catch (...) {
          alive = true;
        }

        if (!alive) {
          if (!state->stopRequested.load() &&
              !state->onLostCalled.exchange(true)) {
            try {
              if (state->onLost) {
                state->onLost();
              }
            } catch (...) {
            }
          }
          break;
        }

        nextProbe = std::chrono::steady_clock::now() + state->interval;
      }

      state->running.store(false);
      {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->threadId = std::thread::id();
      }
    });
  } catch (...) {
    state_->running.store(false);
    state_->stopRequested.store(true);
    throw;
  }
}

void LivenessWatchdog::stop() {
  state_->stopRequested.store(true);

  std::thread threadToJoin;
  {
    std::lock_guard<std::mutex> lock(threadMutex_);
    if (!thread_.joinable()) {
      return;
    }

    std::thread::id watchdogThreadId;
    {
      std::lock_guard<std::mutex> stateLock(state_->mutex);
      watchdogThreadId = state_->threadId;
    }
    const bool calledFromWatchdogThread =
        std::this_thread::get_id() == watchdogThreadId ||
        std::this_thread::get_id() == thread_.get_id();
    if (calledFromWatchdogThread) {
      thread_.detach();
      return;
    }

    threadToJoin = std::move(thread_);
  }

  if (threadToJoin.joinable()) {
    threadToJoin.join();
  }
}

bool LivenessWatchdog::running() const {
  return state_->running.load();
}

}  // namespace broadify::meeting
