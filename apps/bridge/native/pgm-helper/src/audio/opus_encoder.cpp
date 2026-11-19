#include "audio/opus_encoder.h"

#include <opus.h>

namespace broadify::pgm {
namespace {

constexpr int SAMPLE_RATE = 48000;
constexpr int CHANNELS = 2;
constexpr int FRAME_SAMPLES = 960;  // 20 ms
constexpr int MAX_PACKET_BYTES = 1500;

}  // namespace

OpusAudioEncoder::OpusAudioEncoder() {
  int error = OPUS_OK;
  OpusEncoder *encoder = opus_encoder_create(SAMPLE_RATE, CHANNELS, OPUS_APPLICATION_RESTRICTED_LOWDELAY, &error);
  if (error != OPUS_OK || encoder == nullptr) {
    return;
  }
  opus_encoder_ctl(encoder, OPUS_SET_BITRATE(96000));
  opus_encoder_ctl(encoder, OPUS_SET_COMPLEXITY(5));
  opus_encoder_ctl(encoder, OPUS_SET_INBAND_FEC(1));
  opus_encoder_ctl(encoder, OPUS_SET_PACKET_LOSS_PERC(5));
  encoder_ = encoder;
  pending_.reserve(FRAME_SAMPLES * CHANNELS * 2);
}

OpusAudioEncoder::~OpusAudioEncoder() {
  if (encoder_ != nullptr) {
    opus_encoder_destroy(static_cast<OpusEncoder *>(encoder_));
  }
}

void OpusAudioEncoder::push(const AudioChunk &chunk) {
  if (encoder_ == nullptr || chunk.samples == nullptr || chunk.frames == 0) {
    return;
  }
  if (pending_.empty()) {
    pendingStartNs_ = chunk.captureNs;
  }
  pending_.insert(pending_.end(), chunk.samples, chunk.samples + static_cast<size_t>(chunk.frames) * CHANNELS);
  unsigned char packet[MAX_PACKET_BYTES];
  while (pending_.size() >= static_cast<size_t>(FRAME_SAMPLES * CHANNELS)) {
    const int bytes = opus_encode_float(static_cast<OpusEncoder *>(encoder_), pending_.data(), FRAME_SAMPLES, packet, MAX_PACKET_BYTES);
    pending_.erase(pending_.begin(), pending_.begin() + FRAME_SAMPLES * CHANNELS);
    if (bytes > 0 && onPacket) {
      EncodedAudioPacket out;
      out.opus.assign(packet, packet + bytes);
      out.captureNs = pendingStartNs_;
      out.frames = FRAME_SAMPLES;
      onPacket(std::move(out));
    }
    pendingStartNs_ += static_cast<uint64_t>(FRAME_SAMPLES) * 1'000'000'000ULL / SAMPLE_RATE;
  }
}

}  // namespace broadify::pgm
