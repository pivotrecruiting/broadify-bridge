#include "capture/camera_media_type_rank.h"

#include <cstddef>
#include <cstdint>
#include <iostream>
#include <vector>

using broadify::meeting::betterCameraMediaType;
using broadify::meeting::CameraMediaTypeRank;

namespace {

constexpr int kNv12 = 0;
constexpr int kYuy2 = 1;
constexpr int kMjpg = 2;

struct CaseMediaType {
  const char *name;
  CameraMediaTypeRank rank;
};

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "camera_media_type_rank_test failed: " << what << std::endl;
  }
  return condition;
}

std::size_t chooseIndex(const std::vector<CaseMediaType> &types,
                        uint32_t requestedWidth,
                        uint32_t requestedHeight,
                        uint32_t requestedFps) {
  std::size_t best = 0;
  for (std::size_t index = 1; index < types.size(); ++index) {
    if (betterCameraMediaType(types[index].rank, types[best].rank, requestedWidth,
                              requestedHeight, requestedFps)) {
      best = index;
    }
  }
  return best;
}

}  // namespace

int main() {
  bool ok = true;

  const std::vector<CaseMediaType> c920Types{
      {"YUY2 1080p5", {5.0, 1920, 1080, kYuy2}},
      {"MJPG 1080p30", {30.0, 1920, 1080, kMjpg}},
      {"YUY2 720p30", {30.0, 1280, 720, kYuy2}},
      {"YUY2 480p30", {30.0, 640, 480, kYuy2}},
  };
  ok &= expect(chooseIndex(c920Types, 1280, 720, 30) == 2,
               "C920-style list chooses raw 720p30 over MJPG");

  const std::vector<CaseMediaType> realC920Types{
      {"YUY2 720p10", {10.0, 1280, 720, kYuy2}},
      {"YUY2 480p30", {30.0, 640, 480, kYuy2}},
      {"MJPG 720p30", {30.0, 1280, 720, kMjpg}},
      {"MJPG 1080p30", {30.0, 1920, 1080, kMjpg}},
  };
  ok &= expect(chooseIndex(realC920Types, 1920, 1080, 30) == 3,
               "Logitech ladder chooses MJPG 1080p30 for a 1080p request");

  const std::vector<CaseMediaType> nv12Types{
      {"NV12 1080p30", {30.0, 1920, 1080, kNv12}},
      {"NV12 720p30", {30.0, 1280, 720, kNv12}},
      {"NV12 540p30", {30.0, 960, 540, kNv12}},
  };
  ok &= expect(chooseIndex(nv12Types, 1920, 1080, 30) == 0,
               "NV12 ladder chooses 1080p before smaller same-subtype types");

  const std::vector<CaseMediaType> mixedSubtypeTypes{
      {"MJPG 1080p30", {30.0, 1920, 1080, kMjpg}},
      {"MJPG 720p30", {30.0, 1280, 720, kMjpg}},
      {"YUY2 960x540p30", {30.0, 960, 540, kYuy2}},
      {"NV12 848x480p30", {30.0, 848, 480, kNv12}},
  };
  ok &= expect(chooseIndex(mixedSubtypeTypes, 1920, 1080, 30) == 0,
               "1080p MJPG beats smaller raw subtypes for a 1080p request");

  const std::vector<CaseMediaType> comparableFpsTypes{
      {"YUY2 480p30", {30.0, 640, 480, kYuy2}},
      {"MJPG 1080p60", {60.0, 1920, 1080, kMjpg}},
  };
  ok &= expect(chooseIndex(comparableFpsTypes, 1280, 720, 30) == 1,
               "requested size wins before raw subtype when fps is comparable");

  const std::vector<CaseMediaType> lowFpsTypes{
      {"YUY2 1080p5", {5.0, 1920, 1080, kYuy2}},
      {"MJPG 480p24", {24.0, 640, 480, kMjpg}},
  };
  ok &= expect(chooseIndex(lowFpsTypes, 1920, 1080, 30) == 1,
               "never chooses sub-15 fps over 24+ fps");

  const std::vector<CaseMediaType> subtypeTieTypes{
      {"MJPG 1080p30", {30.0, 1920, 1080, kMjpg}},
      {"YUY2 1080p30", {30.0, 1920, 1080, kYuy2}},
      {"NV12 1080p30", {30.0, 1920, 1080, kNv12}},
  };
  ok &= expect(chooseIndex(subtypeTieTypes, 1920, 1080, 30) == 2,
               "NV12 wins among otherwise equal raw formats");

  const std::vector<CaseMediaType> belowRequestSubtypeTieTypes{
      {"MJPG 720p30", {30.0, 1280, 720, kMjpg}},
      {"YUY2 720p30", {30.0, 1280, 720, kYuy2}},
  };
  ok &= expect(chooseIndex(belowRequestSubtypeTieTypes, 1920, 1080, 30) == 1,
               "YUY2 wins same-size tie when all formats are below request");

  const std::vector<CaseMediaType> clamped720Types{
      {"YUY2 720p30", {30.0, 1280, 720, kYuy2}},
      {"MJPG 1080p30", {30.0, 1920, 1080, kMjpg}},
  };
  ok &= expect(chooseIndex(clamped720Types, 1280, 720, 30) == 0,
               "720p clamp request prefers same-size raw over larger MJPG");

  return ok ? 0 : 1;
}
