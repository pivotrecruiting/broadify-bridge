#pragma once

#include <map>
#include <string>

namespace broadify::meeting {

// Decision for committing a successfully reopened camera capture session.
// Pure and platform-neutral so the MediaFoundation-free unit test covers it.
struct CameraReopenCommit {
  int newProgramIndex = 0;
  bool becomesProgram = false;
  int staleSessionIndex = -1;
};

// sessionCameraIds maps each open session index to its device cameraId
// (symbolic link). The reopened camera takes the program slot only when it
// WAS the program camera — matched by device id, never by index, because
// indices shift on re-enumeration after replug. A leftover session of the
// same device under a different index is reported as stale so the caller can
// erase it (otherwise activeCameraSet() keeps announcing a ghost camera).
inline CameraReopenCommit resolveCameraReopenCommit(
    const std::map<int, std::string> &sessionCameraIds, int programIndex,
    const std::string &programCameraId, const std::string &reopenedCameraId,
    int reopenedNewIndex) {
  CameraReopenCommit commit;
  commit.becomesProgram =
      !programCameraId.empty() && reopenedCameraId == programCameraId;
  commit.newProgramIndex =
      commit.becomesProgram ? reopenedNewIndex : programIndex;
  for (const auto &entry : sessionCameraIds) {
    if (entry.second == reopenedCameraId && entry.first != reopenedNewIndex) {
      commit.staleSessionIndex = entry.first;
      break;
    }
  }
  return commit;
}

}  // namespace broadify::meeting
