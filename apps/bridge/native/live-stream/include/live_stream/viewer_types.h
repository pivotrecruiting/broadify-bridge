#pragma once

#include <string>
#include <vector>

namespace broadify::live {

/** One ICE server as the bridge passes it (STUN or TURN with credentials). */
struct IceServerSpec {
  std::string url;
  std::string username;
  std::string credential;
};

/** A browser's recvonly offer for one viewer session. */
struct ViewerOfferRequest {
  std::string viewerId;
  std::string sdp;
  std::vector<IceServerSpec> iceServers;
  std::string profile;  // "auto" | "lan" | "remote"
};

/** Stable error code + message thrown by stream/RPC operations. */
struct RpcFailure {
  std::string code;
  std::string message;
};

}  // namespace broadify::live
