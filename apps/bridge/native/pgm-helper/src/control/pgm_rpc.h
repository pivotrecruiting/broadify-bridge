#pragma once

#include <atomic>
#include <string>
#include <vector>

namespace broadify::pgm {

/** One ICE server as the bridge passes it (STUN or TURN with credentials). */
struct IceServerSpec {
  std::string url;
  std::string username;
  std::string credential;
};

struct ViewerOfferRequest {
  std::string viewerId;
  std::string sdp;
  std::vector<IceServerSpec> iceServers;
  std::string profile;  // "auto" | "lan" | "remote"
};

/**
 * What the RPC layer needs from the engine. Narrow on purpose so the dispatch
 * can be unit-tested against a fake; the real engine owns capture, encoder
 * and WebRTC. Every method returns a JSON object body (without envelope) or
 * throws RpcFailure with a stable code.
 */
struct RpcFailure {
  std::string code;
  std::string message;
};

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

/** Parses the ice_servers array of an offer payload; tolerant of missing credentials. */
std::vector<IceServerSpec> parseIceServers(const std::string &body);

/** Handles one JSON-RPC line ({"id","method","params"}) and returns the response line. */
std::string handlePgmRpc(const std::string &line, PgmEngineApi &engine, std::atomic<bool> &running);

}  // namespace broadify::pgm
