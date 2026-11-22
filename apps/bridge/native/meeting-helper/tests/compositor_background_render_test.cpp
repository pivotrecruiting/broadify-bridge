// The program frame with a background image selected: the image is composited
// while keying is on and never while keying is off, through the production
// renderProgramFrame. Without a camera frame the bottom layers are the whole
// picture, which is the case the rule is about (engine start, camera switch,
// camera layer off). ctest runs this binary twice: with the GPU compositor
// (when the machine has one) and with BROADIFY_MEETING_GPU_COMPOSITOR=0 for
// the CPU path, so both call sites of the background image are covered.
#include "compose/compositor.h"

#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using broadify::meeting::CompositorSnapshot;
using broadify::meeting::Options;
using broadify::meeting::lastCompositorBackend;
using broadify::meeting::renderProgramFrame;

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

namespace {

// 8x8 PNG, every pixel pure red.
const uint8_t kRedPng[] = {
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
    0x44, 0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x02, 0x00, 0x00,
    0x00, 0x4b, 0x6d, 0x29, 0xdc, 0x00, 0x00, 0x00, 0x11, 0x49, 0x44, 0x41, 0x54, 0x78,
    0xda, 0x63, 0xf8, 0xcf, 0xc0, 0x80, 0x15, 0x31, 0x0c, 0x2d, 0x09, 0x00, 0x28, 0xff,
    0x3f, 0xc1, 0xce, 0x77, 0xc8, 0x4f, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82
};

std::vector<uint8_t> render(const Options &options,
                            const CompositorSnapshot &snapshot) {
  std::vector<uint8_t> output;
  renderProgramFrame(options, snapshot, nullptr, nullptr, nullptr, nullptr,
                     nullptr, nullptr, 0u, output);
  CHECK(output.size() == static_cast<size_t>(options.width) * options.height * 4u);
  return output;
}

bool isRed(const std::vector<uint8_t> &frame, const Options &options,
           uint32_t x, uint32_t y) {
  const uint8_t *pixel = &frame[(static_cast<size_t>(y) * options.width + x) * 4u];
  return pixel[0] > 200u && pixel[1] < 60u && pixel[2] < 60u;
}

}  // namespace

int main() {
  const std::filesystem::path imagePath =
      std::filesystem::temp_directory_path() / "broadify-compositor-background-test.png";
  {
    std::ofstream file(imagePath, std::ios::binary | std::ios::trunc);
    CHECK(file.good());
    file.write(reinterpret_cast<const char *>(kRedPng), sizeof(kRedPng));
  }

  Options options;
  options.width = 320u;
  options.height = 180u;

  CompositorSnapshot plain;
  plain.backgroundMode = "dark";
  const std::vector<uint8_t> fill = render(options, plain);
  CHECK(!isRed(fill, options, options.width / 2u, options.height / 2u));

  // Keying off: the selected background is not in the picture.
  CompositorSnapshot keyingOff = plain;
  keyingOff.backgroundImagePath = imagePath.string();
  keyingOff.keyerEnabled = false;
  CHECK(render(options, keyingOff) == fill);

  // Keying on: the same selection fills the frame, without a new configure.
  CompositorSnapshot keyingOn = keyingOff;
  keyingOn.keyerEnabled = true;
  const std::vector<uint8_t> keyed = render(options, keyingOn);
  CHECK(isRed(keyed, options, 0u, 0u));
  CHECK(isRed(keyed, options, options.width / 2u, options.height / 2u));
  CHECK(isRed(keyed, options, options.width - 1u, options.height - 1u));

  // And off again: gone on the next frame.
  CHECK(render(options, keyingOff) == fill);

  std::cout << "compositor_background_render_test backend="
            << lastCompositorBackend() << "\n";
  std::error_code ignored;
  std::filesystem::remove(imagePath, ignored);
  return 0;
}
