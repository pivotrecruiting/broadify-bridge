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

namespace {

// Minimal array-of-objects scan for ice_servers: [{"url":..,"username":..,"credential":..},...].
// The bridge builds this payload (zod-validated), so a tolerant scanner is enough.
std::vector<std::string> splitTopLevelObjects(const std::string &array) {
  std::vector<std::string> out;
  int depth = 0;
  bool inString = false;
  size_t start = std::string::npos;
  for (size_t i = 0; i < array.size(); ++i) {
    const char ch = array[i];
    if (inString) {
      if (ch == '\\') {
        ++i;
      } else if (ch == '"') {
        inString = false;
      }
      continue;
    }
    if (ch == '"') {
      inString = true;
    } else if (ch == '{') {
      if (depth == 0) {
        start = i;
      }
      ++depth;
    } else if (ch == '}') {
      --depth;
      if (depth == 0 && start != std::string::npos) {
        out.push_back(array.substr(start, i - start + 1));
        start = std::string::npos;
      }
    }
  }
  return out;
}

std::string extractArrayField(const std::string &body, const std::string &field) {
  const std::string key = "\"" + field + "\"";
  size_t pos = body.find(key);
  if (pos == std::string::npos) {
    return "";
  }
  pos = body.find('[', pos + key.size());
  if (pos == std::string::npos) {
    return "";
  }
  int depth = 0;
  bool inString = false;
  for (size_t i = pos; i < body.size(); ++i) {
    const char ch = body[i];
    if (inString) {
      if (ch == '\\') {
        ++i;
      } else if (ch == '"') {
        inString = false;
      }
      continue;
    }
    if (ch == '"') {
      inString = true;
    } else if (ch == '[') {
      ++depth;
    } else if (ch == ']') {
      --depth;
      if (depth == 0) {
        return body.substr(pos, i - pos + 1);
      }
    }
  }
  return "";
}

}  // namespace

std::vector<IceServerSpec> parseIceServers(const std::string &body) {
  std::vector<IceServerSpec> servers;
  for (const std::string &object : splitTopLevelObjects(extractArrayField(body, "ice_servers"))) {
    IceServerSpec spec;
    spec.url = extractStringField(object, "url");
    spec.username = extractStringField(object, "username");
    spec.credential = extractStringField(object, "credential");
    if (!spec.url.empty()) {
      servers.push_back(spec);
    }
  }
  return servers;
}

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
