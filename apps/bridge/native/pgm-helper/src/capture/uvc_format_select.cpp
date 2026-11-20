#include "capture/uvc_format_select.h"

namespace broadify::pgm {
namespace {

int subtypeRank(UvcSubtype subtype) {
  switch (subtype) {
    case UvcSubtype::Nv12: return 3;
    case UvcSubtype::Yuy2: return 2;
    case UvcSubtype::Uyvy: return 1;
    case UvcSubtype::Mjpg: return 0;
    case UvcSubtype::Other: break;
  }
  return -1;
}

bool usable(const UvcFormatCandidate &candidate, bool allowMjpg) {
  if (candidate.width == 0 || candidate.height == 0 || candidate.height > kUvcMaxLines) {
    return false;
  }
  if (candidate.subtype == UvcSubtype::Other) {
    return false;
  }
  return allowMjpg || candidate.subtype != UvcSubtype::Mjpg;
}

/** -1, 0, 1 for a's frame rate below, equal to, above b's; a missing rate counts as 0. */
int compareFps(const UvcFormatCandidate &a, const UvcFormatCandidate &b) {
  const uint64_t aNum = a.fpsDen == 0 ? 0 : a.fpsNum;
  const uint64_t bNum = b.fpsDen == 0 ? 0 : b.fpsNum;
  const uint64_t aDen = a.fpsDen == 0 ? 1 : a.fpsDen;
  const uint64_t bDen = b.fpsDen == 0 ? 1 : b.fpsDen;
  const uint64_t left = aNum * bDen;
  const uint64_t right = bNum * aDen;
  return left < right ? -1 : (left > right ? 1 : 0);
}

bool better(const UvcFormatCandidate &candidate, const UvcFormatCandidate &current) {
  const uint64_t candidateArea = static_cast<uint64_t>(candidate.width) * candidate.height;
  const uint64_t currentArea = static_cast<uint64_t>(current.width) * current.height;
  if (candidateArea != currentArea) {
    return candidateArea > currentArea;
  }
  const int fps = compareFps(candidate, current);
  if (fps != 0) {
    return fps > 0;
  }
  return subtypeRank(candidate.subtype) > subtypeRank(current.subtype);
}

}  // namespace

int selectUvcFormat(const std::vector<UvcFormatCandidate> &candidates, bool allowMjpg) {
  int best = -1;
  for (size_t index = 0; index < candidates.size(); ++index) {
    if (!usable(candidates[index], allowMjpg)) {
      continue;
    }
    if (best < 0 || better(candidates[index], candidates[static_cast<size_t>(best)])) {
      best = static_cast<int>(index);
    }
  }
  return best;
}

const char *uvcSubtypeName(UvcSubtype subtype) {
  switch (subtype) {
    case UvcSubtype::Nv12: return "nv12";
    case UvcSubtype::Yuy2: return "yuy2";
    case UvcSubtype::Uyvy: return "uyvy";
    case UvcSubtype::Mjpg: return "mjpg";
    case UvcSubtype::Other: break;
  }
  return "other";
}

const char *uvcOpenErrorCode(uint32_t hresult) {
  switch (hresult) {
    case 0x80070005u:  // E_ACCESSDENIED: camera privacy setting
      return "camera_permission_denied";
    case 0xC00D36B4u:  // MF_E_INVALIDMEDIATYPE
    case 0xC00D36B9u:  // MF_E_NO_MORE_TYPES
    case 0xC00D5212u:  // MF_E_TOPO_CODEC_NOT_FOUND
      return "unsupported_format";
    default:
      // Among them MF_E_HW_MFT_FAILED_START_STREAMING (0xC00D3704), sharing
      // violation (0x80070020) and MF_E_VIDEO_RECORDING_DEVICE_PREEMPTED (0xC00D3EA3).
      return "device_in_use";
  }
}

}  // namespace broadify::pgm
