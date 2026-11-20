// Portable snapshot: frame planes -> JPEG -> base64. The JPEG is decoded again
// with stb_image to check geometry and that the colours survive.
#include "capture/snapshot_portable.h"

#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_STATIC
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#if defined(_MSC_VER)
#pragma warning(push, 0)
#endif
#include "stb_image.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

#include <cstdlib>
#include <iostream>
#include <vector>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "snapshot_portable_test failed: " << m << std::endl; std::exit(1); }

static std::vector<uint8_t> base64Decode(const std::string &text) {
  std::vector<uint8_t> out;
  uint32_t buffer = 0;
  int bits = 0;
  for (const char ch : text) {
    int value = -1;
    if (ch >= 'A' && ch <= 'Z') value = ch - 'A';
    else if (ch >= 'a' && ch <= 'z') value = ch - 'a' + 26;
    else if (ch >= '0' && ch <= '9') value = ch - '0' + 52;
    else if (ch == '+') value = 62;
    else if (ch == '/') value = 63;
    else if (ch == '=') break;
    else fail("character outside the base64 alphabet");
    buffer = (buffer << 6) | static_cast<uint32_t>(value);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((buffer >> bits) & 0xff));
    }
  }
  return out;
}

struct Decoded {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgb;
};

static Decoded decodeJpeg(const std::string &base64) {
  const std::vector<uint8_t> jpeg = base64Decode(base64);
  if (jpeg.size() < 4 || jpeg[0] != 0xff || jpeg[1] != 0xd8 || jpeg[jpeg.size() - 2] != 0xff || jpeg[jpeg.size() - 1] != 0xd9)
    fail("not a JPEG (SOI/EOI)");
  Decoded decoded;
  int channels = 0;
  stbi_uc *pixels = stbi_load_from_memory(jpeg.data(), static_cast<int>(jpeg.size()), &decoded.width, &decoded.height, &channels, 3);
  if (pixels == nullptr) fail("stb_image could not decode the JPEG");
  decoded.rgb.assign(pixels, pixels + static_cast<size_t>(decoded.width) * decoded.height * 3);
  stbi_image_free(pixels);
  return decoded;
}

static void expectNear(const Decoded &image, int x, int y, int r, int g, int b, const char *what) {
  const uint8_t *px = image.rgb.data() + (static_cast<size_t>(y) * image.width + x) * 3;
  const int tolerance = 12;  // JPEG at quality 0.9 plus 4:2:0 chroma
  if (std::abs(px[0] - r) > tolerance || std::abs(px[1] - g) > tolerance || std::abs(px[2] - b) > tolerance) {
    std::cerr << what << ": got " << int(px[0]) << "," << int(px[1]) << "," << int(px[2]) << " expected " << r << "," << g << "," << b << std::endl;
    fail("colour mismatch");
  }
}

int main() {
  // base64: RFC 4648 test vectors.
  const auto b64 = [](const char *text) { return base64Encode(reinterpret_cast<const uint8_t *>(text), std::char_traits<char>::length(text)); };
  if (b64("") != "" || b64("f") != "Zg==" || b64("fo") != "Zm8=" || b64("foo") != "Zm9v" || b64("foob") != "Zm9vYg==" ||
      b64("fooba") != "Zm9vYmE=" || b64("foobar") != "Zm9vYmFy")
    fail("base64 vectors");
  if (!base64Encode(nullptr, 3).empty()) fail("base64 nullptr");

  // NV12 with a padded stride: left half white, right half BT.709 video-range red (Y 63, Cb 102, Cr 240).
  const uint32_t width = 64;
  const uint32_t height = 48;
  const uint32_t stride = 80;
  std::vector<uint8_t> y(static_cast<size_t>(stride) * height, 0);
  std::vector<uint8_t> uv(static_cast<size_t>(stride) * (height / 2), 0);
  for (uint32_t row = 0; row < height; ++row) {
    for (uint32_t col = 0; col < width; ++col) y[row * stride + col] = col < width / 2 ? 235 : 63;
  }
  for (uint32_t row = 0; row < height / 2; ++row) {
    for (uint32_t col = 0; col < width; col += 2) {
      uv[row * stride + col] = col < width / 2 ? 128 : 102;
      uv[row * stride + col + 1] = col < width / 2 ? 128 : 240;
    }
  }
  CapturedFrame nv12;
  nv12.planes[0] = FramePlane{y.data(), stride, height};
  nv12.planes[1] = FramePlane{uv.data(), stride, height / 2};
  nv12.planeCount = 2;
  nv12.width = width;
  nv12.height = height;
  nv12.pixelFormat = "nv12";
  uint32_t outWidth = 0;
  uint32_t outHeight = 0;
  const std::string nv12Jpeg = jpegBase64FromPlanes(nv12, 0.9, outWidth, outHeight);
  if (nv12Jpeg.empty()) fail("nv12 frame gave no JPEG");
  if (outWidth != width || outHeight != height) fail("reported size");
  const Decoded nv12Image = decodeJpeg(nv12Jpeg);
  if (nv12Image.width != static_cast<int>(width) || nv12Image.height != static_cast<int>(height)) fail("decoded size");
  expectNear(nv12Image, 8, 24, 255, 255, 255, "white half");
  expectNear(nv12Image, 56, 24, 255, 0, 0, "red half");

  // YUY2 (Y0 Cb Y1 Cr), the layout an MJPG decoder or a webcam hands over: BT.709 video-range blue (Y 32, Cb 240, Cr 118).
  std::vector<uint8_t> yuy2(static_cast<size_t>(width) * 2 * height);
  for (size_t i = 0; i < yuy2.size(); i += 4) {
    yuy2[i] = 32;
    yuy2[i + 1] = 240;
    yuy2[i + 2] = 32;
    yuy2[i + 3] = 118;
  }
  CapturedFrame packed;
  packed.planes[0] = FramePlane{yuy2.data(), width * 2, height};
  packed.planeCount = 1;
  packed.width = width;
  packed.height = height;
  packed.pixelFormat = "yuy2";
  const std::string yuy2Jpeg = jpegBase64FromPlanes(packed, 0.9, outWidth, outHeight);
  if (yuy2Jpeg.empty()) fail("yuy2 frame gave no JPEG");
  expectNear(decodeJpeg(yuy2Jpeg), 32, 24, 0, 0, 255, "blue");

  // Lower quality gives a smaller picture of the same geometry.
  const std::string small = jpegBase64FromPlanes(nv12, 0.3, outWidth, outHeight);
  if (small.empty() || small.size() >= nv12Jpeg.size()) fail("quality has no effect");

  // Failures: no planes, unknown format, empty geometry. The size outputs stay untouched.
  outWidth = 7;
  outHeight = 9;
  CapturedFrame noPlanes = nv12;
  noPlanes.planeCount = 0;
  if (!jpegBase64FromPlanes(noPlanes, 0.8, outWidth, outHeight).empty()) fail("frame without planes");
  CapturedFrame unknown = nv12;
  unknown.pixelFormat = "unknown";
  if (!jpegBase64FromPlanes(unknown, 0.8, outWidth, outHeight).empty()) fail("unknown pixel format");
  CapturedFrame empty = nv12;
  empty.width = 0;
  if (!jpegBase64FromPlanes(empty, 0.8, outWidth, outHeight).empty()) fail("empty geometry");
  if (outWidth != 7 || outHeight != 9) fail("size outputs touched on failure");

  std::cout << "snapshot_portable_test passed" << std::endl;
  return 0;
}
