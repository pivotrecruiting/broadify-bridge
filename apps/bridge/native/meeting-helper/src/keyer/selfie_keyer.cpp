#include "keyer/selfie_keyer.h"

#include <fstream>
#include <utility>

namespace broadify::meeting {
namespace {

std::string selfieModelPath(const std::string &modelsDir) {
  return modelsDir.empty() ? "selfie_landscape.onnx"
                           : modelsDir + "/selfie_landscape.onnx";
}

bool fileExists(const std::string &path) {
  std::ifstream file(path, std::ios::binary);
  return file.good();
}

}  // namespace

SelfieKeyer::SelfieKeyer(SelfieKeyerOptions options)
    : options_(std::move(options)) {}

KeyerResult SelfieKeyer::apply(const VideoFrame &input,
                               const KeyerSettings &settings) {
  (void)input;
  (void)settings;
  KeyerResult result;
  result.status = status();
  return result;
}

KeyerStatus SelfieKeyer::status() const {
  KeyerStatus status;
  status.activeKeyer = "passthrough";
  status.backend = "selfie_landscape";
  status.qualityMode = "realtime";
  status.modelPath = selfieModelPath(options_.modelsDir);
  status.fallbackActive = true;
  if (!fileExists(status.modelPath)) {
    status.fallbackReason = "model_missing";
    return status;
  }
#if defined(_WIN32)
  status.fallbackReason = "directml_selfie_not_implemented";
#else
  status.fallbackReason = "windows_only";
#endif
  return status;
}

}  // namespace broadify::meeting
