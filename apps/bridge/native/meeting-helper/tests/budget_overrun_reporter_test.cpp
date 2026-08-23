#include "pipeline/budget_overrun_reporter.h"

#include <chrono>
#include <cstdlib>
#include <iostream>

using broadify::meeting::BudgetOverrunEvent;
using broadify::meeting::BudgetOverrunReporter;
using broadify::meeting::BudgetOverrunReporterConfig;

namespace {

using TimePoint = BudgetOverrunReporter::TimePoint;

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "budget_overrun_reporter_test failed: " << what << std::endl;
  }
  return condition;
}

TimePoint at(int seconds) {
  return TimePoint{} + std::chrono::seconds(seconds);
}

}  // namespace

int main() {
  bool ok = true;

  BudgetOverrunReporterConfig config;
  config.consecutiveFrames = 3u;
  config.repeatInterval = std::chrono::seconds(10);
  BudgetOverrunReporter reporter(config);

  ok &= expect(reporter.update(40.0, 30.0, at(0)) == BudgetOverrunEvent::None,
               "first over-budget frame is quiet");
  ok &= expect(reporter.update(40.0, 30.0, at(1)) == BudgetOverrunEvent::None,
               "second over-budget frame is quiet");
  ok &= expect(reporter.update(40.0, 30.0, at(2)) == BudgetOverrunEvent::Overrun,
               "third consecutive over-budget frame emits");
  ok &= expect(reporter.update(40.0, 30.0, at(8)) == BudgetOverrunEvent::None,
               "persistent overrun is rate limited");
  ok &= expect(reporter.update(40.0, 30.0, at(12)) == BudgetOverrunEvent::Overrun,
               "persistent overrun repeats after the rate limit");

  BudgetOverrunEvent recovered = BudgetOverrunEvent::None;
  for (int i = 0; i < 20; ++i) {
    recovered = reporter.update(10.0, 30.0, at(13 + i));
    if (recovered == BudgetOverrunEvent::Recovered) {
      break;
    }
  }
  ok &= expect(recovered == BudgetOverrunEvent::Recovered,
               "recovery emits once when EMA falls back under budget");
  ok &= expect(reporter.update(10.0, 30.0, at(31)) == BudgetOverrunEvent::None,
               "recovery is not repeated per frame");

  reporter.reset();
  ok &= expect(!reporter.overrunActive(), "reset clears active state");
  ok &= expect(reporter.emaMs() < 0.0, "reset clears EMA");

  return ok ? EXIT_SUCCESS : EXIT_FAILURE;
}
