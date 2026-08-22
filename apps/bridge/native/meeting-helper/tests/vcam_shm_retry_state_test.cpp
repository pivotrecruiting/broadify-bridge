#include "preview/vcam_shm_retry_state.h"

#include <cstdlib>
#include <iostream>
#include <string>

using namespace broadify::meeting;

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

void testOpenSequenceReasons() {
  const VcamShmRetryDecision absent =
      decideVcamShmRetry(VcamShmOpenOutcome::ServiceRingAbsent, 1000u, 2000u);
  CHECK(!absent.useShm);
  CHECK(absent.keepTcp);
  CHECK(absent.retry);
  CHECK(absent.nextRetryMs == 3000u);
  CHECK(std::string(absent.reason) == "service_ring_absent");

  const VcamShmRetryDecision privilege =
      decideVcamShmRetry(VcamShmOpenOutcome::GlobalNamespacePrivilege, 3000u,
                         2000u);
  CHECK(!privilege.useShm);
  CHECK(privilege.keepTcp);
  CHECK(privilege.retry);
  CHECK(privilege.nextRetryMs == 5000u);
  CHECK(std::string(privilege.reason) == "global_namespace_privilege");

  const VcamShmRetryDecision opened =
      decideVcamShmRetry(VcamShmOpenOutcome::OpenedServiceRing, 5000u, 2000u);
  CHECK(opened.useShm);
  CHECK(opened.keepTcp);
  CHECK(!opened.retry);
  CHECK(opened.nextRetryMs == 0u);
  CHECK(std::string(opened.reason) == "opened_service_ring");
}

void testCreatedGlobalIsShmWithoutRetry() {
  const VcamShmRetryDecision created =
      decideVcamShmRetry(VcamShmOpenOutcome::CreatedGlobal, 7000u, 2000u);
  CHECK(created.useShm);
  CHECK(created.keepTcp);
  CHECK(!created.retry);
  CHECK(created.nextRetryMs == 0u);
  CHECK(std::string(created.reason) == "created_global");
}

int main() {
  testOpenSequenceReasons();
  testCreatedGlobalIsShmWithoutRetry();
  std::cout << "vcam_shm_retry_state_test passed\n";
  return 0;
}
