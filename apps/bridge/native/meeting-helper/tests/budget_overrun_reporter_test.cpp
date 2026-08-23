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
  ok &= expect(reporter.update(40.0, 30.0, at(10)) == BudgetOverrunEvent::None,
               "re-entry setup first over-budget frame is quiet");
  ok &= expect(reporter.update(40.0, 30.0, at(11)) == BudgetOverrunEvent::None,
               "re-entry setup second over-budget frame is quiet");
  ok &= expect(reporter.update(40.0, 30.0, at(12)) == BudgetOverrunEvent::Overrun,
               "re-entry setup emits initial overrun");
  recovered = BudgetOverrunEvent::None;
  for (int i = 0; i < 20; ++i) {
    recovered = reporter.update(10.0, 30.0, at(13 + i));
    if (recovered == BudgetOverrunEvent::Recovered) {
      break;
    }
  }
  ok &= expect(recovered == BudgetOverrunEvent::Recovered,
               "re-entry setup recovers");
  ok &= expect(reporter.update(40.0, 30.0, at(15)) == BudgetOverrunEvent::None,
               "post-recovery re-entry is rate limited");
  ok &= expect(reporter.update(40.0, 30.0, at(16)) == BudgetOverrunEvent::None,
               "second post-recovery overrun sample remains rate limited");
  ok &= expect(reporter.update(40.0, 30.0, at(17)) == BudgetOverrunEvent::None,
               "third post-recovery overrun sample remains rate limited");
  ok &= expect(reporter.update(40.0, 30.0, at(22)) == BudgetOverrunEvent::Overrun,
               "post-recovery re-entry emits after rate limit");

  reporter.reset();
  ok &= expect(reporter.update(26.0, 33.333, at(40)) == BudgetOverrunEvent::None,
               "12ms overhead plus 14ms session stays within real 30fps frame budget");
  ok &= expect(reporter.update(26.0, 33.333, at(41)) == BudgetOverrunEvent::None,
               "second within-budget real-frame sample is quiet");
  ok &= expect(reporter.update(26.0, 33.333, at(42)) == BudgetOverrunEvent::None,
               "third within-budget real-frame sample is quiet");
  ok &= expect(reporter.update(42.0, 33.333, at(43)) == BudgetOverrunEvent::None,
               "12ms overhead plus 30ms session starts overrun count");
  ok &= expect(reporter.update(42.0, 33.333, at(44)) == BudgetOverrunEvent::None,
               "second real-frame overrun sample is quiet");
  ok &= expect(reporter.update(42.0, 33.333, at(45)) == BudgetOverrunEvent::None,
               "third real-frame overrun sample crosses EMA only");
  ok &= expect(reporter.update(42.0, 33.333, at(46)) == BudgetOverrunEvent::None,
               "fourth real-frame overrun sample is quiet");
  ok &= expect(reporter.update(42.0, 33.333, at(47)) == BudgetOverrunEvent::Overrun,
               "30ms session plus overhead emits against real frame budget");

  reporter.reset();
  ok &= expect(!reporter.overrunActive(), "reset clears active state");
  ok &= expect(reporter.emaMs() < 0.0, "reset clears EMA");

  return ok ? EXIT_SUCCESS : EXIT_FAILURE;
}
