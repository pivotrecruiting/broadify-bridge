#include "control/pgm_rpc.h"

#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"

#include <string>

namespace broadify::pgm {

using broadify::helper::errorResponse;
using broadify::helper::extractObjectField;
using broadify::helper::extractStringField;
using broadify::helper::jsonEscape;
using broadify::helper::okResponse;

std::string handlePgmRpc(const std::string &line, PgmEngineApi &engine, std::atomic<bool> &running) {
  const std::string id = extractStringField(line, "id");
  const std::string method = extractStringField(line, "method");
  const std::string params = extractObjectField(line, "params");
  try {
    if (method == "control.ping") {
      return okResponse(id, "{\"pong\":true}");
    }
    if (method == "control.shutdown") {
      broadify::helper::noteHelperExitReason("control_shutdown");
      running.store(false);
      return okResponse(id, "{\"stopping\":true}");
    }
    if (method == "pgm.inputs.list") {
      return okResponse(id, engine.inputsListJson());
    }
    if (method == "pgm.status") {
      return okResponse(id, engine.statusJson());
    }
    if (method == "pgm.perf.get") {
      return okResponse(id, engine.perfJson());
    }
    if (method == "pgm.sessions.list") {
      return okResponse(id, engine.sessionsJson());
    }
    if (method == "pgm.source.select") {
      const std::string inputId = extractStringField(params, "input_id");
      if (inputId.empty()) {
        return errorResponse(id, "invalid_params", "input_id is required");
      }
      engine.selectSource(inputId, extractStringField(params, "profile"));
      return okResponse(id, engine.statusJson());
    }
    if (method == "pgm.source.clear") {
      engine.clearSource();
      return okResponse(id, engine.statusJson());
    }
    if (method == "pgm.viewer.offer") {
      ViewerOfferRequest request;
      request.viewerId = extractStringField(params, "viewer_id");
      request.sdp = extractStringField(params, "sdp");
      request.profile = extractStringField(params, "profile");
      request.iceServers = parseIceServers(params);
      if (request.viewerId.empty() || request.sdp.empty()) {
        return errorResponse(id, "invalid_params", "viewer_id and sdp are required");
      }
      const std::string answer = engine.viewerOffer(request);
      return okResponse(id, "{\"sdp\":\"" + jsonEscape(answer) + "\"}");
    }
    if (method == "pgm.recording.start") {
      const std::string filePath = extractStringField(params, "file_path");
      if (filePath.empty()) {
        return errorResponse(id, "invalid_params", "file_path is required");
      }
      return okResponse(id, engine.recordingStart(filePath));
    }
    if (method == "pgm.recording.stop") {
      return okResponse(id, engine.recordingStop());
    }
    if (method == "pgm.recording.status") {
      return okResponse(id, engine.recordingStatusJson());
    }
    if (method == "pgm.snapshot") {
      const double quality = broadify::helper::extractDoubleField(params, "quality", 0.8);
      return okResponse(id, engine.snapshotJson(quality));
    }
    if (method == "pgm.viewer.close") {
      const std::string viewerId = extractStringField(params, "viewer_id");
      if (viewerId.empty()) {
        return errorResponse(id, "invalid_params", "viewer_id is required");
      }
      engine.viewerClose(viewerId);
      return okResponse(id, "{\"closed\":true}");
    }
    return errorResponse(id, "unknown_method", "Unknown pgm-helper method: " + method);
  } catch (const RpcFailure &failure) {
    return errorResponse(id, failure.code, failure.message);
  } catch (const std::exception &error) {
    return errorResponse(id, "internal_error", error.what());
  }
}

}  // namespace broadify::pgm
