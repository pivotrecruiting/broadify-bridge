#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

namespace broadify::vcam {

// One decoded program frame from the raw-frame stream. BGRA8, dense
// (width*height*4), top-down — ready to memcpy into an MFVideoFormat_RGB32
// buffer without a swizzle.
struct RawFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t sequence = 0;
  std::vector<uint8_t> bgra;
};

// Consumes the meeting-helper raw-frame TCP stream (Channel A) on
// 127.0.0.1:<port>. Runs a background thread that connects, performs the HTTP
// handshake, parses the "BFRG" records and keeps only the latest frame,
// reconnecting with backoff on any error. Holding the connection open keeps the
// meeting pipeline rendering (the connection counts as a vcam client).
//
// Designed to be owned by the MF media source, which runs inside the Windows
// Frame Server process — hence loopback TCP rather than the helper's shared
// memory (which may not be visible across the frame-server session).
class RawFrameClient {
 public:
  explicit RawFrameClient(uint16_t port);
  ~RawFrameClient();

  RawFrameClient(const RawFrameClient &) = delete;
  RawFrameClient &operator=(const RawFrameClient &) = delete;

  void start();
  void stop();

  // Copies the latest frame. Returns false if no frame has arrived yet.
  bool copyLatest(RawFrame &out) const;

  // Copies only when the latest sequence differs from lastSequence.
  bool copyLatestIfNew(uint64_t lastSequence, RawFrame &out) const;

  // True when no fresh frame has arrived within the stale window (~2s). The
  // media source shows a splash while stale.
  bool isStale() const;

 private:
  void run();

  const uint16_t port_;
  std::atomic<bool> running_{false};
  std::thread thread_;

  mutable std::mutex mutex_;
  bool hasFrame_ = false;
  RawFrame latest_;
  uint64_t lastArrivalMs_ = 0;  // GetTickCount64() at last frame
};

}  // namespace broadify::vcam
