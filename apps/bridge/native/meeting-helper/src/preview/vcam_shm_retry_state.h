#pragma once

#include <cstdint>

namespace broadify::meeting {

enum class VcamShmOpenOutcome {
  OpenedServiceRing,
  CreatedGlobal,
  ServiceRingAbsent,
  GlobalNamespacePrivilege,
  CreateFailed,
};

struct VcamShmRetryDecision {
  bool useShm = false;
  bool keepTcp = true;
  bool retry = false;
  uint64_t nextRetryMs = 0;
  const char *reason = "service_ring_absent";
};

inline VcamShmRetryDecision decideVcamShmRetry(VcamShmOpenOutcome outcome,
                                               uint64_t nowMs,
                                               uint64_t retryDelayMs) {
  switch (outcome) {
    case VcamShmOpenOutcome::OpenedServiceRing:
      return VcamShmRetryDecision{true, true, false, 0u,
                                  "opened_service_ring"};
    case VcamShmOpenOutcome::CreatedGlobal:
      return VcamShmRetryDecision{true, true, false, 0u, "created_global"};
    case VcamShmOpenOutcome::GlobalNamespacePrivilege:
      return VcamShmRetryDecision{false, true, true, nowMs + retryDelayMs,
                                  "global_namespace_privilege"};
    case VcamShmOpenOutcome::CreateFailed:
      return VcamShmRetryDecision{false, true, true, nowMs + retryDelayMs,
                                  "create_failed"};
    case VcamShmOpenOutcome::ServiceRingAbsent:
    default:
      return VcamShmRetryDecision{false, true, true, nowMs + retryDelayMs,
                                  "service_ring_absent"};
  }
}

}  // namespace broadify::meeting
