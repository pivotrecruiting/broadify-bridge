#include "capture/snapshot_portable.h"

#include "live_stream/frame_to_nv12.h"
#include "live_stream/nv12_layout.h"

#include <algorithm>
#include <vector>

// JPEG encoder: stb_image_write, vendored with the meeting helper. Compiled
// into this translation unit only (static), without its file writers.
#if defined(_MSC_VER)
#pragma warning(push, 0)
#endif
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC
#define STBI_WRITE_NO_STDIO
#include "stb_image_write.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

namespace broadify::pgm {
namespace {

uint8_t clampToByte(int value) { return static_cast<uint8_t>(value < 0 ? 0 : (value > 255 ? 255 : value)); }

void appendJpegBytes(void *context, void *data, int size) {
  if (size <= 0) {
    return;
  }
  std::vector<uint8_t> *out = static_cast<std::vector<uint8_t> *>(context);
  const uint8_t *bytes = static_cast<const uint8_t *>(data);
  out->insert(out->end(), bytes, bytes + size);
}

}  // namespace

std::string base64Encode(const uint8_t *data, size_t size) {
  static const char ALPHABET[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  if (data == nullptr || size == 0) {
    return out;
  }
  out.reserve((size + 2) / 3 * 4);
  size_t index = 0;
  for (; index + 3 <= size; index += 3) {
    const uint32_t triple = (static_cast<uint32_t>(data[index]) << 16) | (static_cast<uint32_t>(data[index + 1]) << 8) | data[index + 2];
    out.push_back(ALPHABET[(triple >> 18) & 0x3f]);
    out.push_back(ALPHABET[(triple >> 12) & 0x3f]);
    out.push_back(ALPHABET[(triple >> 6) & 0x3f]);
    out.push_back(ALPHABET[triple & 0x3f]);
  }
  const size_t rest = size - index;
  if (rest == 1) {
    const uint32_t triple = static_cast<uint32_t>(data[index]) << 16;
    out.push_back(ALPHABET[(triple >> 18) & 0x3f]);
    out.push_back(ALPHABET[(triple >> 12) & 0x3f]);
    out.append("==");
  } else if (rest == 2) {
    const uint32_t triple = (static_cast<uint32_t>(data[index]) << 16) | (static_cast<uint32_t>(data[index + 1]) << 8);
    out.push_back(ALPHABET[(triple >> 18) & 0x3f]);
    out.push_back(ALPHABET[(triple >> 12) & 0x3f]);
    out.push_back(ALPHABET[(triple >> 6) & 0x3f]);
    out.push_back('=');
  }
  return out;
}

std::string jpegBase64FromPlanes(const CapturedFrame &frame, double quality, uint32_t &outWidth, uint32_t &outHeight) {
  const uint32_t width = frame.width;
  const uint32_t height = frame.height;
  // Bounds keep the buffers below sane; the capture path never exceeds 1080 lines.
  if (width == 0 || height == 0 || width > 8192 || height > 8192) {
    return "";
  }
  const uint32_t yStride = width;
  const uint32_t uvStride = 2 * nv12ChromaWidth(width);
  const size_t ySize = static_cast<size_t>(yStride) * height;
  const size_t uvSize = static_cast<size_t>(uvStride) * nv12ChromaRows(height);
  std::vector<uint8_t> nv12(ySize + uvSize);
  std::vector<uint8_t> scratch;
  const Nv12Planes planes{nv12.data(), yStride, nv12.data() + ySize, uvStride};
  if (!frameToNv12(frame, planes, width, height, scratch)) {
    return "";
  }

  // BT.709, video range (16..235 / 16..240), 8-bit fixed point.
  std::vector<uint8_t> rgb(static_cast<size_t>(width) * height * 3);
  for (uint32_t row = 0; row < height; ++row) {
    const uint8_t *yRow = planes.y + static_cast<size_t>(row) * yStride;
    const uint8_t *uvRow = planes.uv + static_cast<size_t>(row / 2) * uvStride;
    uint8_t *out = rgb.data() + static_cast<size_t>(row) * width * 3;
    for (uint32_t col = 0; col < width; ++col) {
      const int c = 298 * (static_cast<int>(yRow[col]) - 16) + 128;
      const int d = static_cast<int>(uvRow[(col / 2) * 2]) - 128;
      const int e = static_cast<int>(uvRow[(col / 2) * 2 + 1]) - 128;
      out[0] = clampToByte((c + 459 * e) >> 8);
      out[1] = clampToByte((c - 55 * d - 136 * e) >> 8);
      out[2] = clampToByte((c + 541 * d) >> 8);
      out += 3;
    }
  }

  std::vector<uint8_t> jpeg;
  jpeg.reserve(rgb.size() / 8);
  const int stbQuality = std::min(100, std::max(1, static_cast<int>(quality * 100.0 + 0.5)));
  if (stbi_write_jpg_to_func(appendJpegBytes, &jpeg, static_cast<int>(width), static_cast<int>(height), 3, rgb.data(), stbQuality) == 0 ||
      jpeg.empty()) {
    return "";
  }
  outWidth = width;
  outHeight = height;
  return base64Encode(jpeg.data(), jpeg.size());
}

}  // namespace broadify::pgm
