#include "util/sha256.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <iomanip>
#include <sstream>
#include <vector>

namespace broadify::meeting {
namespace {

constexpr std::array<uint32_t, 64> kRoundConstants = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

uint32_t rotateRight(uint32_t value, uint32_t count) {
  return (value >> count) | (value << (32u - count));
}

void processBlock(const uint8_t *block, std::array<uint32_t, 8> &state) {
  std::array<uint32_t, 64> words{};
  for (size_t i = 0; i < 16; ++i) {
    words[i] = (static_cast<uint32_t>(block[i * 4u]) << 24u) |
               (static_cast<uint32_t>(block[i * 4u + 1u]) << 16u) |
               (static_cast<uint32_t>(block[i * 4u + 2u]) << 8u) |
               static_cast<uint32_t>(block[i * 4u + 3u]);
  }
  for (size_t i = 16; i < 64; ++i) {
    const uint32_t s0 = rotateRight(words[i - 15], 7u) ^ rotateRight(words[i - 15], 18u) ^ (words[i - 15] >> 3u);
    const uint32_t s1 = rotateRight(words[i - 2], 17u) ^ rotateRight(words[i - 2], 19u) ^ (words[i - 2] >> 10u);
    words[i] = words[i - 16] + s0 + words[i - 7] + s1;
  }

  uint32_t a = state[0];
  uint32_t b = state[1];
  uint32_t c = state[2];
  uint32_t d = state[3];
  uint32_t e = state[4];
  uint32_t f = state[5];
  uint32_t g = state[6];
  uint32_t h = state[7];

  for (size_t i = 0; i < 64; ++i) {
    const uint32_t s1 = rotateRight(e, 6u) ^ rotateRight(e, 11u) ^ rotateRight(e, 25u);
    const uint32_t ch = (e & f) ^ ((~e) & g);
    const uint32_t temp1 = h + s1 + ch + kRoundConstants[i] + words[i];
    const uint32_t s0 = rotateRight(a, 2u) ^ rotateRight(a, 13u) ^ rotateRight(a, 22u);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

std::string digestToHex(const std::array<uint32_t, 8> &state) {
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (const uint32_t word : state) {
    out << std::setw(8) << word;
  }
  return out.str();
}

}  // namespace

std::string sha256FileHex(const std::string &path) {
  FILE *file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    return "";
  }

  std::array<uint32_t, 8> state = {
      0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
      0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
  };
  std::vector<uint8_t> pending;
  pending.reserve(128);
  uint64_t totalBytes = 0;

  std::array<uint8_t, 4096> buffer{};
  size_t readBytes = 0;
  while ((readBytes = std::fread(buffer.data(), 1, buffer.size(), file)) > 0) {
    totalBytes += static_cast<uint64_t>(readBytes);
    pending.insert(pending.end(), buffer.begin(), buffer.begin() + static_cast<long>(readBytes));
    while (pending.size() >= 64u) {
      processBlock(pending.data(), state);
      pending.erase(pending.begin(), pending.begin() + 64);
    }
  }
  std::fclose(file);

  pending.push_back(0x80u);
  while ((pending.size() % 64u) != 56u) {
    pending.push_back(0u);
  }
  const uint64_t totalBits = totalBytes * 8u;
  for (int shift = 56; shift >= 0; shift -= 8) {
    pending.push_back(static_cast<uint8_t>((totalBits >> static_cast<uint32_t>(shift)) & 0xffu));
  }
  for (size_t offset = 0; offset < pending.size(); offset += 64u) {
    processBlock(pending.data() + offset, state);
  }

  return digestToHex(state);
}

}  // namespace broadify::meeting
