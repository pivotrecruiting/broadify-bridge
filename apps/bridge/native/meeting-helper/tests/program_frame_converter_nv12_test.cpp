// The NV12 frame converter of the program stream (the Windows one, pure C++):
// RGBA program frame -> frame-size NV12 planes, and from there through the
// module the Media Foundation encoder's input stage uses (frameToNv12) into a
// contiguous NV12 frame of the encode target - copied when the target is the
// frame size, scaled when the bitrate ladder picked a smaller one. Sizes come
// from each frame: 1920x1080, portrait 1080x1920 and an odd size.
#include "live/program_frame_converter.h"

#include "live_stream/bitrate_ladder.h"
#include "live_stream/frame_to_nv12.h"
#include "live_stream/mf_encoder_policy.h"
#include "live_stream/nv12_layout.h"
#include "preview/preview_frame_store.h"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using namespace broadify::live;
using broadify::meeting::PreviewFrame;
using broadify::meeting::ProgramFrameConverter;
using broadify::meeting::createProgramFrameConverter;

namespace {

void fail(const std::string &message) {
  std::cerr << "program_frame_converter_nv12_test failed: " << message << std::endl;
  std::exit(1);
}

struct Yuv {
  uint8_t y;
  uint8_t cb;
  uint8_t cr;
};

// BT.709 limited range (Y 16-235, CbCr 16-240) of the colours used below.
constexpr Yuv kRed = {63, 102, 240};
constexpr Yuv kBlue = {32, 240, 118};
constexpr Yuv kWhite = {235, 128, 128};
constexpr Yuv kBlack = {16, 128, 128};

struct Rgb {
  uint8_t r;
  uint8_t g;
  uint8_t b;
};

// Left half one colour, right half another; alpha set, as the compositor delivers it.
PreviewFrame makeFrame(uint32_t width, uint32_t height, Rgb left, Rgb right) {
  PreviewFrame frame;
  frame.width = width;
  frame.height = height;
  frame.sequence = 1;
  frame.rgba.resize(static_cast<size_t>(width) * height * 4);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      uint8_t *px = frame.rgba.data() + (static_cast<size_t>(y) * width + x) * 4;
      const Rgb &colour = x < width / 2 ? left : right;
      px[0] = colour.r;
      px[1] = colour.g;
      px[2] = colour.b;
      px[3] = 255;
    }
  }
  return frame;
}

uint8_t at(const FramePlane &plane, uint32_t x, uint32_t y) { return plane.data[static_cast<size_t>(y) * plane.stride + x]; }

void expectYuv(const FramePlane &luma, const FramePlane &chroma, uint32_t x, uint32_t y, const Yuv &expected, const std::string &label) {
  const uint8_t gotY = at(luma, x, y);
  const uint8_t gotCb = at(chroma, 2 * (x / 2), y / 2);
  const uint8_t gotCr = at(chroma, 2 * (x / 2) + 1, y / 2);
  if (gotY != expected.y || gotCb != expected.cb || gotCr != expected.cr) {
    fail(label + ": pixel " + std::to_string(x) + "," + std::to_string(y) + " is (" + std::to_string(gotY) + "," + std::to_string(gotCb) +
         "," + std::to_string(gotCr) + "), expected (" + std::to_string(expected.y) + "," + std::to_string(expected.cb) + "," +
         std::to_string(expected.cr) + ")");
  }
}

// No converted or scaled sample has this value: every plane stays within the video range (16..240).
constexpr uint8_t kUnwritten = 0x01;

// What the Media Foundation encoder does with a frame: contiguous NV12 of its planned size at the default stride.
struct EncoderInput {
  std::vector<uint8_t> bytes;
  uint32_t width = 0;
  uint32_t height = 0;
  FramePlane luma() const { return {bytes.data(), width, height}; }
  FramePlane chroma() const { return {bytes.data() + static_cast<size_t>(width) * height, width, height / 2}; }
};

EncoderInput toEncoderInput(const CapturedFrame &frame, const EncodeTarget &target, const std::string &label) {
  const EncoderAttributePlan plan = planEncoderAttributes(target);
  EncoderInput input;
  input.width = plan.width;
  input.height = plan.height;
  const size_t lumaSize = static_cast<size_t>(input.width) * input.height;
  input.bytes.assign(lumaSize + lumaSize / 2, kUnwritten);
  const Nv12Planes planes{input.bytes.data(), input.width, input.bytes.data() + lumaSize, input.width};
  std::vector<uint8_t> scratch;
  if (!frameToNv12(frame, planes, input.width, input.height, scratch)) {
    fail(label + ": the encoder's input stage refused the converted frame");
  }
  if (!scratch.empty()) {
    fail(label + ": NV12 from the converter must not need a second conversion");
  }
  return input;
}

void runCase(ProgramFrameConverter &converter, uint32_t width, uint32_t height, EncodeProfile profile, const std::string &label) {
  const PreviewFrame frame = makeFrame(width, height, {255, 0, 0}, {0, 0, 255});
  if (!converter.prepare(width, height)) fail(label + ": prepare: " + converter.failure());
  CapturedFrame captured;
  captured.captureNs = 42;
  if (!converter.convert(frame, captured)) fail(label + ": frame was not converted");

  // Frame-size NV12 in two CPU planes, nothing else.
  if (captured.pixelFormat != "nv12" || captured.planeCount != 2 || captured.nativeHandle != nullptr) fail(label + ": frame description");
  if (captured.width != width || captured.height != height) fail(label + ": the converted frame must keep the program frame size");
  if (captured.captureNs != 42) fail(label + ": the caller stamps the capture time");
  const FramePlane &luma = captured.planes[0];
  const FramePlane &chroma = captured.planes[1];
  if (luma.data == nullptr || luma.stride != width || luma.rows != height) fail(label + ": luma plane");
  if (chroma.data == nullptr || chroma.stride != 2 * nv12ChromaWidth(width) || chroma.rows != nv12ChromaRows(height)) fail(label + ": chroma plane");
  if (chroma.data != luma.data + static_cast<size_t>(width) * height) fail(label + ": the planes must be contiguous");

  expectYuv(luma, chroma, 0, 0, kRed, label);
  expectYuv(luma, chroma, width / 4, height / 2, kRed, label);
  expectYuv(luma, chroma, 0, height - 1, kRed, label);
  expectYuv(luma, chroma, width - 1, 0, kBlue, label);
  expectYuv(luma, chroma, width - 1 - width / 4, height / 2, kBlue, label);
  expectYuv(luma, chroma, width - 1, height - 1, kBlue, label);

  // Through the encoder's input stage to the target of the bitrate ladder.
  const EncodeTarget target = selectEncodeTarget(width, height, 30, 1, profile);
  const EncoderInput input = toEncoderInput(captured, target, label);
  const FramePlane scaledLuma = input.luma();
  const FramePlane scaledChroma = input.chroma();
  expectYuv(scaledLuma, scaledChroma, 0, 0, kRed, label + " at the encode size");
  expectYuv(scaledLuma, scaledChroma, input.width - 1, input.height - 1, kBlue, label + " at the encode size");
  if (input.width <= width && input.height <= height) {
    // Copied or scaled down: the quarter points are still inside their flat half.
    expectYuv(scaledLuma, scaledChroma, input.width / 4, input.height / 2, kRed, label + " at the encode size");
    expectYuv(scaledLuma, scaledChroma, input.width - 1 - input.width / 4, input.height / 2, kBlue, label + " at the encode size");
  }
  for (const uint8_t byte : input.bytes) {
    if (byte == kUnwritten) {
      fail(label + ": the encoder input was not written completely");
    }
  }

  converter.release(captured);
  if (captured.planeCount != 0 || captured.planes[0].data != nullptr || captured.planes[1].data != nullptr) {
    fail(label + ": release must take the planes back");
  }
}

}  // namespace

int main() {
  const std::unique_ptr<ProgramFrameConverter> converter = createProgramFrameConverter();

  // The worker copies the frame out of the store before it converts, and spaces out failed encoder set-ups.
  if (converter->runsUnderStoreLock()) fail("the NV12 conversion must not run under the PreviewFrameStore lock");
  if (converter->encoderRetryInterval().count() < 500) fail("a failed Media Foundation encoder set-up needs a retry pause");

  // One converter across the cases, as one stream sees program format changes.
  runCase(*converter, 1920, 1080, EncodeProfile::Lan, "1920x1080 lan (target == frame)");
  runCase(*converter, 1920, 1080, EncodeProfile::Remote, "1920x1080 remote (target 1280x720)");
  runCase(*converter, 1080, 1920, EncodeProfile::Lan, "1080x1920 lan");
  runCase(*converter, 1080, 1920, EncodeProfile::Remote, "1080x1920 remote (target 720x1280)");
  runCase(*converter, 3840, 2160, EncodeProfile::Lan, "3840x2160 lan (target 1920x1080)");
  runCase(*converter, 641, 361, EncodeProfile::Lan, "641x361 (odd size, target 640x360)");
  runCase(*converter, 4, 2, EncodeProfile::Lan, "4x2 (below the encoder's minimum)");

  // Grey levels land on the limits of the video range.
  {
    const PreviewFrame frame = makeFrame(64, 36, {255, 255, 255}, {0, 0, 0});
    CapturedFrame captured;
    if (!converter->prepare(64, 36) || !converter->convert(frame, captured)) fail("grey: convert");
    expectYuv(captured.planes[0], captured.planes[1], 8, 8, kWhite, "white");
    expectYuv(captured.planes[0], captured.planes[1], 56, 28, kBlack, "black");
    converter->release(captured);
  }

  // The same size keeps the buffer, another size rebuilds it.
  {
    const PreviewFrame landscape = makeFrame(1280, 720, {255, 0, 0}, {0, 0, 255});
    const PreviewFrame portrait = makeFrame(720, 1280, {255, 0, 0}, {0, 0, 255});
    CapturedFrame first;
    CapturedFrame second;
    if (!converter->prepare(1280, 720) || !converter->convert(landscape, first)) fail("reuse: first frame");
    const uint8_t *buffer = first.planes[0].data;
    converter->release(first);
    if (!converter->prepare(1280, 720) || !converter->convert(landscape, second)) fail("reuse: second frame");
    if (second.planes[0].data != buffer) fail("an unchanged frame size must keep the buffer");
    converter->release(second);

    // Bounded by the prepared geometry: nothing is written for a frame that does not match it.
    CapturedFrame refused;
    if (converter->convert(portrait, refused)) fail("a 720x1280 frame must not be converted into a 1280x720 buffer");
    if (refused.planeCount != 0) fail("a refused frame must stay empty");
    PreviewFrame shortFrame = landscape;
    shortFrame.rgba.resize(shortFrame.rgba.size() - 1);
    if (converter->convert(shortFrame, refused)) fail("a short RGBA payload must not be converted");
    PreviewFrame emptyFrame;
    if (converter->convert(emptyFrame, refused)) fail("an empty frame must not be converted");

    if (!converter->prepare(720, 1280) || !converter->convert(portrait, second)) fail("resize: portrait frame");
    if (second.width != 720 || second.height != 1280 || second.planes[0].stride != 720 || second.planes[0].rows != 1280) {
      fail("the buffer was not rebuilt for 720x1280");
    }
    converter->release(second);
  }

  // An empty or absurd size is refused with a reason; reset() drops the buffer.
  {
    CapturedFrame captured;
    const PreviewFrame frame = makeFrame(320, 180, {255, 0, 0}, {0, 0, 255});
    if (converter->prepare(0, 1080) || converter->failure().empty()) fail("an empty width must be refused with a reason");
    if (converter->convert(frame, captured)) fail("a converter whose prepare failed must not hand out a frame");
    if (converter->prepare(1920, 0)) fail("an empty height must be refused");
    if (converter->prepare(0x40000000u, 2)) fail("a width whose RGBA stride overflows 32 bits must be refused");
    if (!converter->prepare(320, 180) || !converter->convert(frame, captured)) fail("prepare after a refusal");
    converter->release(captured);
    converter->reset();
    if (converter->convert(frame, captured)) fail("a reset converter must not hand out a frame");
  }

  std::cout << "program_frame_converter_nv12_test passed" << std::endl;
  return 0;
}
