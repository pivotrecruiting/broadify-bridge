#include "control/pgm_rpc.h"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>

using namespace broadify::pgm;

static void fail(const char *m) { std::cerr << "pgm_rpc_dispatch_test failed: " << m << std::endl; std::exit(1); }
static bool has(const std::string &s, const std::string &n) { return s.find(n) != std::string::npos; }

class FakeEngine final : public PgmEngineApi {
 public:
  std::string inputsListJson() override { return "{\"inputs\":[{\"id\":\"uvc:a\"}]}"; }
  std::string statusJson() override { return "{\"state\":\"" + state + "\"}"; }
  std::string perfJson() override { return "{\"capture_fps\":60}"; }
  std::string sessionsJson() override { return "{\"sessions\":[]}"; }
  void selectSource(const std::string &inputId, const std::string &profile) override {
    if (inputId == "missing") throw RpcFailure{"input_not_found", "no such input"};
    selected = inputId; selectedProfile = profile; state = "running";
  }
  void clearSource() override { selected.clear(); state = "idle"; }
  std::string viewerOffer(const ViewerOfferRequest &request) override {
    lastOffer = request;
    return "v=0\r\nanswer";
  }
  void viewerClose(const std::string &viewerId) override { closed = viewerId; }
  std::string state = "idle", selected, selectedProfile, closed;
  ViewerOfferRequest lastOffer;
};

int main() {
  FakeEngine engine;
  std::atomic<bool> running{true};
  std::string r = handlePgmRpc("{\"id\":\"1\",\"method\":\"control.ping\"}", engine, running);
  if (!has(r, "\"pong\":true") || !has(r, "\"id\":\"1\"")) fail("ping");
  r = handlePgmRpc("{\"id\":\"2\",\"method\":\"pgm.inputs.list\"}", engine, running);
  if (!has(r, "uvc:a")) fail("inputs");
  r = handlePgmRpc("{\"id\":\"3\",\"method\":\"pgm.source.select\",\"params\":{\"input_id\":\"uvc:a\",\"profile\":\"remote\"}}", engine, running);
  if (engine.selected != "uvc:a" || engine.selectedProfile != "remote" || !has(r, "running")) fail("select");
  r = handlePgmRpc("{\"id\":\"4\",\"method\":\"pgm.source.select\",\"params\":{\"input_id\":\"missing\"}}", engine, running);
  if (!has(r, "input_not_found") || !has(r, "\"ok\":false")) fail("select failure code");
  r = handlePgmRpc("{\"id\":\"5\",\"method\":\"pgm.source.select\",\"params\":{}}", engine, running);
  if (!has(r, "invalid_params")) fail("select missing input");
  const std::string offer =
      "{\"id\":\"6\",\"method\":\"pgm.viewer.offer\",\"params\":{\"viewer_id\":\"v1\",\"sdp\":\"v=0\\r\\nm=video 9\","
      "\"ice_servers\":[{\"url\":\"stun:stun.example:3478\"},{\"url\":\"turn:turn.example:3478?transport=udp\",\"username\":\"u,1\",\"credential\":\"p}w\"}]}}";
  r = handlePgmRpc(offer, engine, running);
  if (!has(r, "\"sdp\":\"v=0\\r\\nanswer\"")) fail("offer answer");
  if (engine.lastOffer.viewerId != "v1" || engine.lastOffer.sdp != "v=0\r\nm=video 9") fail("offer fields");
  if (engine.lastOffer.iceServers.size() != 2 || engine.lastOffer.iceServers[1].username != "u,1" || engine.lastOffer.iceServers[1].credential != "p}w") fail("ice servers");
  r = handlePgmRpc("{\"id\":\"7\",\"method\":\"pgm.viewer.close\",\"params\":{\"viewer_id\":\"v1\"}}", engine, running);
  if (engine.closed != "v1" || !has(r, "\"closed\":true")) fail("close");
  r = handlePgmRpc("{\"id\":\"8\",\"method\":\"nope\"}", engine, running);
  if (!has(r, "unknown_method")) fail("unknown");
  r = handlePgmRpc("{\"id\":\"9\",\"method\":\"control.shutdown\"}", engine, running);
  if (running.load() || !has(r, "stopping")) fail("shutdown");
  std::cout << "pgm_rpc_dispatch_test passed" << std::endl;
  return 0;
}
