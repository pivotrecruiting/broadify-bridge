#include "capture/camera_reopen_policy.h"

#include <iostream>
#include <map>
#include <string>

using broadify::meeting::CameraReopenCommit;
using broadify::meeting::resolveCameraReopenCommit;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "camera_reopen_policy_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;

  // A reopened standby/PiP camera must never take over the program slot.
  {
    const std::map<int, std::string> sessions = {{0, "cam-a"}, {1, "cam-b"}};
    const CameraReopenCommit commit =
        resolveCameraReopenCommit(sessions, 0, "cam-a", "cam-b", 1);
    ok &= expect(!commit.becomesProgram, "pip reopen does not become program");
    ok &= expect(commit.newProgramIndex == 0, "pip reopen keeps program index");
    ok &= expect(commit.staleSessionIndex == -1,
                 "same-index pip reopen has no stale session");
  }

  // The program camera reopening under a shifted index follows the program
  // slot along and reports the leftover session under the old index as stale.
  {
    const std::map<int, std::string> sessions = {{0, "cam-a"}, {1, "cam-b"}};
    const CameraReopenCommit commit =
        resolveCameraReopenCommit(sessions, 0, "cam-a", "cam-a", 2);
    ok &= expect(commit.becomesProgram, "program reopen becomes program");
    ok &= expect(commit.newProgramIndex == 2, "program follows the new index");
    ok &= expect(commit.staleSessionIndex == 0,
                 "old-index session reported stale");
  }

  // Reopen under the unchanged index: no stale session, program follows.
  {
    const std::map<int, std::string> sessions = {{0, "cam-a"}};
    const CameraReopenCommit commit =
        resolveCameraReopenCommit(sessions, 0, "cam-a", "cam-a", 0);
    ok &= expect(commit.becomesProgram, "same-index program reopen");
    ok &= expect(commit.newProgramIndex == 0, "same-index program index");
    ok &= expect(commit.staleSessionIndex == -1, "no stale on same index");
  }

  // A PiP camera reopening under a shifted index still cleans up its leftover
  // session without touching the program slot.
  {
    const std::map<int, std::string> sessions = {{0, "cam-a"}, {1, "cam-b"}};
    const CameraReopenCommit commit =
        resolveCameraReopenCommit(sessions, 0, "cam-a", "cam-b", 3);
    ok &= expect(!commit.becomesProgram, "shifted pip stays non-program");
    ok &= expect(commit.newProgramIndex == 0, "shifted pip keeps program");
    ok &= expect(commit.staleSessionIndex == 1, "shifted pip stale session");
  }

  // Unknown program camera id (legacy select-only state): stay conservative.
  {
    const std::map<int, std::string> sessions = {{0, "cam-a"}};
    const CameraReopenCommit commit =
        resolveCameraReopenCommit(sessions, 0, "", "cam-a", 1);
    ok &= expect(!commit.becomesProgram, "empty program id never hijacks");
    ok &= expect(commit.newProgramIndex == 0, "empty program id keeps index");
    ok &= expect(commit.staleSessionIndex == 0,
                 "empty program id still cleans stale session");
  }

  return ok ? 0 : 1;
}
