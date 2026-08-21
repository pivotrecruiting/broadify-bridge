#include "util/win_qos.h"

#include <cstdlib>
#include <iostream>

#if defined(_WIN32)
#include <windows.h>
#include <avrt.h>
#include <timeapi.h>
#ifndef PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
#define PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION 0x4
#endif
#endif

namespace broadify::meeting {

bool meetingWinQosEnabled() {
  const char *value = std::getenv("BROADIFY_MEETING_WIN_QOS");
  return value == nullptr || value[0] != '0';
}

void configureMeetingProcessQos() {
#if defined(_WIN32)
  if (!meetingWinQosEnabled()) {
    return;
  }
  PROCESS_POWER_THROTTLING_STATE throttling{};
  throttling.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
  throttling.ControlMask =
      PROCESS_POWER_THROTTLING_EXECUTION_SPEED |
      PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
  throttling.StateMask = 0;
  if (!SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling,
                             &throttling, sizeof(throttling))) {
    std::cout << "{\"type\":\"meeting_win_qos\",\"event\":\"process_power_throttling_failed\","
              << "\"error_code\":" << GetLastError() << "}" << std::endl;
  }
#endif
}

ScopedWinTimerResolution::ScopedWinTimerResolution() {
#if defined(_WIN32)
  if (meetingWinQosEnabled() && timeBeginPeriod(1) == TIMERR_NOERROR) {
    active_ = true;
  }
#endif
}

ScopedWinTimerResolution::~ScopedWinTimerResolution() {
#if defined(_WIN32)
  if (active_) {
    timeEndPeriod(1);
  }
#endif
}

ScopedWinMmcss::ScopedWinMmcss(const wchar_t *taskName) {
#if defined(_WIN32)
  if (!meetingWinQosEnabled()) {
    return;
  }
  DWORD taskIndex = 0;
  handle_ = AvSetMmThreadCharacteristicsW(taskName, &taskIndex);
  if (handle_ == nullptr) {
    std::cout << "{\"type\":\"meeting_win_qos\",\"event\":\"mmcss_failed\","
              << "\"error_code\":" << GetLastError() << "}" << std::endl;
  }
#else
  (void)taskName;
#endif
}

ScopedWinMmcss::~ScopedWinMmcss() {
#if defined(_WIN32)
  if (handle_ != nullptr) {
    AvRevertMmThreadCharacteristics(handle_);
  }
#endif
}

}  // namespace broadify::meeting
