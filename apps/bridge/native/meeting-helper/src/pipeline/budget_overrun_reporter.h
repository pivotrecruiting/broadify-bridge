#pragma once

#include <chrono>
#include <cstdint>

namespace broadify::meeting {

enum class BudgetOverrunEvent {
  None,
  Overrun,
  Recovered,
};

struct BudgetOverrunReporterConfig {
  double emaWeight = 0.2;
  uint64_t consecutiveFrames = 30u;
  std::chrono::steady_clock::duration repeatInterval = std::chrono::seconds(10);
};

class BudgetOverrunReporter {
 public:
  using TimePoint = std::chrono::steady_clock::time_point;

  BudgetOverrunReporter() = default;
  explicit BudgetOverrunReporter(const BudgetOverrunReporterConfig &config)
      : config_(config) {}

  BudgetOverrunEvent update(double programFrameMs, double budgetMs, TimePoint now) {
    if (programFrameMs <= 0.0 || budgetMs <= 0.0) {
      return BudgetOverrunEvent::None;
    }
    emaMs_ = emaMs_ < 0.0 ? programFrameMs
                          : config_.emaWeight * programFrameMs +
                                (1.0 - config_.emaWeight) * emaMs_;
    if (emaMs_ > budgetMs) {
      ++overBudgetFrames_;
      if (overBudgetFrames_ < config_.consecutiveFrames) {
        return BudgetOverrunEvent::None;
      }
      if (!overrunActive_ || now - lastOverrunEventAt_ >= config_.repeatInterval) {
        overrunActive_ = true;
        lastOverrunEventAt_ = now;
        return BudgetOverrunEvent::Overrun;
      }
      return BudgetOverrunEvent::None;
    }

    overBudgetFrames_ = 0u;
    if (overrunActive_) {
      overrunActive_ = false;
      return BudgetOverrunEvent::Recovered;
    }
    return BudgetOverrunEvent::None;
  }

  double emaMs() const { return emaMs_; }
  bool overrunActive() const { return overrunActive_; }

  void reset() {
    emaMs_ = -1.0;
    overBudgetFrames_ = 0u;
    overrunActive_ = false;
    lastOverrunEventAt_ = TimePoint{};
  }

 private:
  BudgetOverrunReporterConfig config_{};
  double emaMs_ = -1.0;
  uint64_t overBudgetFrames_ = 0u;
  bool overrunActive_ = false;
  TimePoint lastOverrunEventAt_{};
};

}  // namespace broadify::meeting
