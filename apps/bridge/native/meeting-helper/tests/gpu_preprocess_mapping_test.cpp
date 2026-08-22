#include "compose/gpu_preprocess.h"

#include <cassert>
#include <cmath>

using broadify::meeting::buildGpuPreprocessMapping;
using broadify::meeting::modnetLetterboxMapping;

int main() {
  const auto letterbox = modnetLetterboxMapping(1280, 720, 512, 512);
  const auto table = buildGpuPreprocessMapping(1280, 720, letterbox);
  assert(letterbox.contentX == 0u);
  assert(letterbox.contentY == 112u);
  assert(letterbox.contentWidth == 512u);
  assert(letterbox.contentHeight == 288u);
  assert(table.size() == static_cast<size_t>(512u * 288u * 3u));

  const auto &first = table.front();
  assert(first.dstX == 0u);
  assert(first.dstY == 112u);
  assert(first.channel == 0u);
  assert(first.tensorIndex == 112u * 512u);
  assert(std::abs(first.srcLeft - 0.0) < 1.0e-9);
  assert(std::abs(first.srcRight - 2.5) < 1.0e-9);

  const auto &green = table[1];
  assert(green.channel == 1u);
  assert(green.tensorIndex == 512u * 512u + first.tensorIndex);

  const auto portrait = modnetLetterboxMapping(720, 1280, 320, 320);
  const auto portraitTable = buildGpuPreprocessMapping(720, 1280, portrait);
  assert(portrait.contentX == 70u);
  assert(portrait.contentY == 0u);
  assert(portrait.contentWidth == 180u);
  assert(portrait.contentHeight == 320u);
  assert(portraitTable.front().dstX == 70u);
  assert(portraitTable.front().dstY == 0u);
  return 0;
}
