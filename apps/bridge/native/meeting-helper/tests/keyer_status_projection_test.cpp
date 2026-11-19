#include "keyer/keyer_status_projection.h"

#include <iostream>
#include <string>

using broadify::meeting::KeyerStatus;
using broadify::meeting::projectFusedDegradation;

namespace {

constexpr const char *kVision = "vision_person_segmentation";

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "keyer_status_projection_test failed: " << what << std::endl;
  }
  return condition;
}

KeyerStatus visionRunning() {
  KeyerStatus status;
  status.activeKeyer = kVision;
  status.backend = kVision;
  status.fallbackActive = false;
  status.fallbackReason.clear();
  status.inferenceMs = 7.5;
  return status;
}

bool sameAs(const KeyerStatus &a, const KeyerStatus &b) {
  return a.activeKeyer == b.activeKeyer && a.fallbackActive == b.fallbackActive &&
         a.fallbackReason == b.fallbackReason && a.backend == b.backend &&
         a.inferenceMs == b.inferenceMs;
}

}  // namespace

int main() {
  bool ok = true;

  // No degradation reason: the status passes through untouched.
  {
    const KeyerStatus input = visionRunning();
    const KeyerStatus out = projectFusedDegradation(input, "");
    ok &= expect(sameAs(out, input), "no reason must leave the status unchanged");
  }

  // Fused CoreML failed, Vision took over: the downgrade must become visible
  // as a fallback with the fused reason.
  {
    const KeyerStatus out =
        projectFusedDegradation(visionRunning(), "model_load_failed");
    ok &= expect(out.fallbackActive, "degraded fused + vision active => fallbackActive");
    ok &= expect(out.fallbackReason == "model_load_failed",
                 "degraded fused + vision active => reason copied");
    ok &= expect(out.activeKeyer == kVision,
                 "degraded fused + vision active => activeKeyer stays vision");
    ok &= expect(out.inferenceMs == 7.5, "degraded fused keeps the vision inference time");
  }

  // Any fused reason counts (no requested-model condition: on macOS the fused
  // CoreML keyer is the production keyer independent of the requested model).
  {
    const KeyerStatus out =
        projectFusedDegradation(visionRunning(), "model_compile_failed");
    ok &= expect(out.fallbackActive && out.fallbackReason == "model_compile_failed" &&
                     out.activeKeyer == kVision,
                 "vision active after fused failure => fallback");
  }

  // The requested model is what runs (fused recovered, stale reason): unchanged.
  {
    KeyerStatus input = visionRunning();
    input.activeKeyer = "coreml_modnet";
    input.backend = "coreml_modnet";
    const KeyerStatus out = projectFusedDegradation(input, "inference_failed");
    ok &= expect(sameAs(out, input), "active non-vision keyer => unchanged");
  }

  // A real Vision fallback (e.g. loading) keeps its own, more specific reason.
  {
    KeyerStatus input = visionRunning();
    input.activeKeyer = "passthrough";
    input.fallbackActive = true;
    input.fallbackReason = "loading";
    const KeyerStatus out = projectFusedDegradation(input, "model_load_failed");
    ok &= expect(sameAs(out, input), "passthrough with own reason => unchanged");
  }

  if (!ok) {
    return 1;
  }
  std::cout << "keyer_status_projection_test passed" << std::endl;
  return 0;
}
