#include "live_stream/frame_to_nv12.h"

#include "live_stream/nv12_scale.h"
#include "live_stream/rgba_to_nv12.h"
#include "live_stream/yuv422_to_nv12.h"

namespace broadify::live {
namespace {

enum class Packed { None, Yuy2, Uyvy, Bgra, Rgba };

Packed packedFormat(const std::string &pixelFormat) {
  if (pixelFormat == "yuy2") {
    return Packed::Yuy2;
  }
  if (pixelFormat == "uyvy") {
    return Packed::Uyvy;
  }
  if (pixelFormat == "bgra") {
    return Packed::Bgra;
  }
  if (pixelFormat == "rgba") {
    return Packed::Rgba;
  }
  return Packed::None;
}

bool convertPacked(Packed format, const FramePlane &plane, uint32_t width, uint32_t height, const Nv12Planes &dst) {
  switch (format) {
    case Packed::Yuy2:
      return yuv422ToNv12(plane.data, plane.stride, width, height, Yuv422Order::Yuy2, dst);
    case Packed::Uyvy:
      return yuv422ToNv12(plane.data, plane.stride, width, height, Yuv422Order::Uyvy, dst);
    case Packed::Bgra:
      return rgbaToNv12(plane.data, plane.stride, width, height, RgbaOrder::Bgra, dst);
    case Packed::Rgba:
      return rgbaToNv12(plane.data, plane.stride, width, height, RgbaOrder::Rgba, dst);
    case Packed::None:
      break;
  }
  return false;
}

}  // namespace

bool frameToNv12(const CapturedFrame &frame, const Nv12Planes &dst, uint32_t dstWidth, uint32_t dstHeight,
                 std::vector<uint8_t> &scratch) {
  if (frame.width == 0 || frame.height == 0 || dstWidth == 0 || dstHeight == 0 || frame.planeCount == 0 ||
      frame.planes[0].data == nullptr || frame.planes[0].rows < frame.height) {
    return false;
  }
  if (frame.pixelFormat == "nv12") {
    if (frame.planeCount < 2 || frame.planes[1].data == nullptr || frame.planes[1].rows < nv12ChromaRows(frame.height)) {
      return false;
    }
    const Nv12ConstPlanes src{frame.planes[0].data, frame.planes[0].stride, frame.planes[1].data, frame.planes[1].stride};
    // Equal sizes are a row copy inside the scaler.
    return scaleNv12(src, frame.width, frame.height, dst, dstWidth, dstHeight);
  }
  const Packed format = packedFormat(frame.pixelFormat);
  if (format == Packed::None) {
    return false;
  }
  if (frame.width == dstWidth && frame.height == dstHeight) {
    return convertPacked(format, frame.planes[0], frame.width, frame.height, dst);
  }
  const uint32_t yStride = frame.width;
  const uint32_t uvStride = 2 * nv12ChromaWidth(frame.width);
  const size_t ySize = static_cast<size_t>(yStride) * frame.height;
  const size_t uvSize = static_cast<size_t>(uvStride) * nv12ChromaRows(frame.height);
  if (scratch.size() < ySize + uvSize) {
    scratch.resize(ySize + uvSize);
  }
  const Nv12Planes native{scratch.data(), yStride, scratch.data() + ySize, uvStride};
  if (!convertPacked(format, frame.planes[0], frame.width, frame.height, native)) {
    return false;
  }
  const Nv12ConstPlanes src{native.y, native.yStride, native.uv, native.uvStride};
  return scaleNv12(src, frame.width, frame.height, dst, dstWidth, dstHeight);
}

}  // namespace broadify::live
