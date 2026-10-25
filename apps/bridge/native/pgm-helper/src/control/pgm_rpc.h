#pragma once

#include "common/live_types.h"

#include <atomic>
#include <string>
#include <vector>

namespace broadify::pgm {

/**
 * What the RPC layer needs from the engine. Narrow on purpose so the dispatch
 * can be unit-tested against a fake; the real engine owns capture, encoder
 * and WebRTC. Every method returns a JSON object body (without envelope) or
 * throws RpcFailure with a stable code.
 */
class PgmEngineApi {
 public:
  virtual ~PgmEngineApi() = default;
  virtual std::string inputsListJson() = 0;
  virtual std::string statusJson() = 0;
  virtual std::string perfJson() = 0;
  virtual void selectSource(const std::string &inputId, const std::string &profile) = 0;
  virtual void clearSource() = 0;
  /** Returns the answer SDP. */
  virtual std::string viewerOffer(const ViewerOfferRequest &request) = 0;
  virtual void viewerClose(const std::string &viewerId) = 0;
  virtual std::string sessionsJson() = 0;
  /** Starts the MP4 recording of the program; returns the recording status JSON. */
  virtual std::string recordingStart(const std::string &filePath) = 0;
  virtual std::string recordingStop() = 0;
  virtual std::string recordingStatusJson() = 0;
  /** JSON {jpeg_base64,width,height} of the latest frame. */
  virtual std::string snapshotJson(double quality) = 0;
};

/** Handles one JSON-RPC line ({"id","method","params"}) and returns the response line. */
std::string handlePgmRpc(const std::string &line, PgmEngineApi &engine, std::atomic<bool> &running);

}  // namespace broadify::pgm
