#pragma once

#include <string>

namespace broadify::meeting {

bool meetingWinQosEnabled();
void configureMeetingProcessQos();

class ScopedWinTimerResolution {
 public:
  ScopedWinTimerResolution();
  ~ScopedWinTimerResolution();
  ScopedWinTimerResolution(const ScopedWinTimerResolution &) = delete;
  ScopedWinTimerResolution &operator=(const ScopedWinTimerResolution &) = delete;

 private:
  bool active_ = false;
};

class ScopedWinMmcss {
 public:
  explicit ScopedWinMmcss(const wchar_t *taskName);
  ~ScopedWinMmcss();
  ScopedWinMmcss(const ScopedWinMmcss &) = delete;
  ScopedWinMmcss &operator=(const ScopedWinMmcss &) = delete;

 private:
  void *handle_ = nullptr;
};

}  // namespace broadify::meeting
