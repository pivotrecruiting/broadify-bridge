#include "keyer/keyer.h"

namespace broadify::meeting {

VideoFrame copyPassthroughFrame(const VideoFrame &input) {
  VideoFrame output;
  output.width = input.width;
  output.height = input.height;
  output.timestampNs = input.timestampNs;
  output.rgba = input.rgba;
  return output;
}

}  // namespace broadify::meeting
