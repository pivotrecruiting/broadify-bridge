#include "live_stream/h264_annexb.h"

namespace broadify::live {
namespace {

constexpr uint8_t START_CODE[4] = {0, 0, 0, 1};

void appendStartCode(std::vector<uint8_t> &out) { out.insert(out.end(), START_CODE, START_CODE + 4); }

}  // namespace

bool avccToAnnexB(const uint8_t *data, size_t size, size_t nalLengthSize, std::vector<uint8_t> &out) {
  if (data == nullptr || nalLengthSize < 1 || nalLengthSize > 4) {
    return false;
  }
  size_t offset = 0;
  while (offset + nalLengthSize <= size) {
    uint32_t nalLength = 0;
    for (size_t i = 0; i < nalLengthSize; ++i) {
      nalLength = (nalLength << 8) | data[offset + i];
    }
    offset += nalLengthSize;
    if (nalLength == 0 || offset + nalLength > size) {
      return false;
    }
    appendStartCode(out);
    out.insert(out.end(), data + offset, data + offset + nalLength);
    offset += nalLength;
  }
  return offset == size;
}

void prependParameterSets(const H264ParameterSets &sets, std::vector<uint8_t> &annexB) {
  std::vector<uint8_t> prefixed;
  prefixed.reserve(sets.sps.size() + sets.pps.size() + 8 + annexB.size());
  if (!sets.sps.empty()) {
    appendStartCode(prefixed);
    prefixed.insert(prefixed.end(), sets.sps.begin(), sets.sps.end());
  }
  if (!sets.pps.empty()) {
    appendStartCode(prefixed);
    prefixed.insert(prefixed.end(), sets.pps.begin(), sets.pps.end());
  }
  prefixed.insert(prefixed.end(), annexB.begin(), annexB.end());
  annexB.swap(prefixed);
}

namespace {

// Visits every NAL payload start after a 3- or 4-byte start code.
template <typename Visitor>
void forEachNal(const std::vector<uint8_t> &annexB, Visitor &&visit) {
  const size_t n = annexB.size();
  size_t i = 0;
  while (i + 3 <= n) {
    if (annexB[i] == 0 && annexB[i + 1] == 0 && annexB[i + 2] == 1) {
      if (i + 3 < n) {
        if (!visit(annexB[i + 3])) {
          return;
        }
      }
      i += 3;
    } else {
      i += 1;
    }
  }
}

}  // namespace

int firstNalType(const std::vector<uint8_t> &annexB) {
  int type = -1;
  forEachNal(annexB, [&](uint8_t header) {
    type = header & 0x1f;
    return false;
  });
  return type;
}

bool containsIdr(const std::vector<uint8_t> &annexB) {
  bool idr = false;
  forEachNal(annexB, [&](uint8_t header) {
    if ((header & 0x1f) == 5) {
      idr = true;
      return false;
    }
    return true;
  });
  return idr;
}

bool containsNalType(const std::vector<uint8_t> &annexB, int nalType) {
  bool found = false;
  forEachNal(annexB, [&](uint8_t header) {
    if ((header & 0x1f) == nalType) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

bool splitAnnexBParameterSets(const uint8_t *data, size_t size, H264ParameterSets &out) {
  out.sps.clear();
  out.pps.clear();
  if (data == nullptr) {
    return false;
  }
  // Offset of the next 00 00 01 at or after `from`, or `size`.
  const auto nextStartCode = [&](size_t from) {
    for (size_t i = from; i + 3 <= size; ++i) {
      if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) {
        return i;
      }
    }
    return size;
  };
  size_t start = nextStartCode(0);
  while (start < size) {
    const size_t begin = start + 3;
    const size_t next = nextStartCode(begin);
    // A NAL never ends in 0x00: zeros before the next start code (its 4-byte
    // form or trailing_zero_8bits) are not part of it.
    size_t end = next;
    while (end > begin && data[end - 1] == 0) {
      --end;
    }
    if (end > begin) {
      const int type = data[begin] & 0x1f;
      if (type == 7 && out.sps.empty()) {
        out.sps.assign(data + begin, data + end);
      } else if (type == 8 && out.pps.empty()) {
        out.pps.assign(data + begin, data + end);
      }
    }
    start = next;
  }
  if (out.sps.empty() || out.pps.empty()) {
    out.sps.clear();
    out.pps.clear();
    return false;
  }
  return true;
}

int spsProfileIdc(const std::vector<uint8_t> &annexB) {
  // profile_idc is the first byte of the SPS payload, right after the NAL header.
  const size_t n = annexB.size();
  size_t i = 0;
  while (i + 3 <= n) {
    if (annexB[i] == 0 && annexB[i + 1] == 0 && annexB[i + 2] == 1) {
      if (i + 3 < n && (annexB[i + 3] & 0x1f) == 7) {
        return i + 4 < n ? static_cast<int>(annexB[i + 4]) : -1;
      }
      i += 3;
    } else {
      i += 1;
    }
  }
  return -1;
}

}  // namespace broadify::live
