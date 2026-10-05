#include "capture/screen_capture_source.h"
#include "capture/screen_capture_stub.h"

#include <iostream>

using broadify::meeting::CaptureSize;
using broadify::meeting::ScreenCaptureCapabilities;
using broadify::meeting::ScreenCaptureStartOptions;
using broadify::meeting::ScreenSourceInfo;
using broadify::meeting::StubScreenCaptureSource;
using broadify::meeting::VideoFrame;
using broadify::meeting::clampScreenCaptureSize;
using broadify::meeting::parseScreenSourceId;
using broadify::meeting::screenCapabilitiesToJson;
using broadify::meeting::screenSourceToJson;
using broadify::meeting::selectCaptureMipLevel;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "screen_capture_source_test failed: " << what << std::endl;
  }
  return condition;
}

bool contains(const std::string &value, const std::string &needle) {
  return value.find(needle) != std::string::npos;
}

}  // namespace

int main() {
  bool ok = true;

  CaptureSize size = clampScreenCaptureSize(3840, 2160, 1920, 1080);
  ok &= expect(size.width == 1920 && size.height == 1080,
               "4k clamps to 1080p");
  size = clampScreenCaptureSize(2560, 1440, 1920, 1080);
  ok &= expect(size.width == 1920 && size.height == 1080,
               "1440p clamps to 1080p");
  size = clampScreenCaptureSize(1600, 900, 1920, 1080);
  ok &= expect(size.width == 1600 && size.height == 900,
               "capture size never upscales");
  size = clampScreenCaptureSize(1919, 1079, 1920, 1080);
  ok &= expect(size.width == 1918 && size.height == 1078,
               "odd dimensions are rounded down to even");
  size = clampScreenCaptureSize(1080, 1920, 1920, 1080);
  ok &= expect(size.width == 608 && size.height == 1080,
               "portrait capture fits into max bounds");
  size = clampScreenCaptureSize(1, 1, 1920, 1080);
  ok &= expect(size.width == 2 && size.height == 2,
               "minimum capture size is 2x2");

  ok &= expect(selectCaptureMipLevel(3840, 2160, 1920, 1080) == 1,
               "3840x2160 mip level");
  ok &= expect(selectCaptureMipLevel(2560, 1440, 1920, 1080) == 0,
               "2560x1440 mip level");
  ok &= expect(selectCaptureMipLevel(5120, 2880, 1920, 1080) == 1,
               "5120x2880 mip level");
  ok &= expect(selectCaptureMipLevel(7680, 4320, 1920, 1080) == 2,
               "7680x4320 mip level");
  ok &= expect(selectCaptureMipLevel(1280, 720, 1920, 1080) == 0,
               "1280x720 mip level");

  std::string kind;
  uint64_t handle = 0u;
  ok &= expect(parseScreenSourceId("monitor:0x1A", kind, handle) &&
                   kind == "monitor" && handle == 26u,
               "parse monitor source id");
  ok &= expect(parseScreenSourceId("window:0x0", kind, handle) &&
                   kind == "window" && handle == 0u,
               "parse zero window source id");
  ok &= expect(!parseScreenSourceId("foo", kind, handle), "reject bare id");
  ok &= expect(!parseScreenSourceId("monitor:", kind, handle),
               "reject missing handle");
  ok &= expect(!parseScreenSourceId("monitor:0xZZ", kind, handle),
               "reject bad hex");
  ok &= expect(!parseScreenSourceId("monitor:1A", kind, handle),
               "reject missing hex prefix");

  ScreenSourceInfo source;
  source.sourceId = "monitor:0x10001";
  source.kind = "display";
  source.title = "Main \"Desk\"";
  source.width = 3840;
  source.height = 2160;
  source.primary = true;
  const std::string sourceJson = screenSourceToJson(source);
  ok &= expect(contains(sourceJson, "\"source_id\":\"monitor:0x10001\"") &&
                   contains(sourceJson, "\"kind\":\"display\"") &&
                   contains(sourceJson, "\"title\":\"Main \\\"Desk\\\"\"") &&
                   contains(sourceJson, "\"app_name\":null") &&
                   contains(sourceJson, "\"width\":3840") &&
                   contains(sourceJson, "\"height\":2160") &&
                   contains(sourceJson, "\"primary\":true") &&
                   contains(sourceJson, "\"active\":false"),
               "source JSON contract keys");
  source.appName = "Slides";
  ok &= expect(contains(screenSourceToJson(source), "\"app_name\":\"Slides\""),
               "source JSON app_name string");

  ScreenCaptureCapabilities caps;
  caps.permissionStatus = "unsupported";
  const std::string capsJson = screenCapabilitiesToJson(caps);
  ok &= expect(contains(capsJson, "\"supported\":false") &&
                   contains(capsJson, "\"system_picker\":false") &&
                   contains(capsJson, "\"enumeration\":false") &&
                   contains(capsJson, "\"permission_status\":\"unsupported\"") &&
                   contains(capsJson, "\"unsupported_reason\":null"),
               "capabilities JSON null unsupported_reason");
  caps.unsupportedReason = "unsupported_os";
  ok &= expect(contains(screenCapabilitiesToJson(caps),
                        "\"unsupported_reason\":\"unsupported_os\""),
               "capabilities JSON unsupported_reason string");

  StubScreenCaptureSource stub;
  ok &= expect(!stub.capabilities().supported, "stub defaults unsupported");
  ok &= expect(!stub.start("monitor:0x1", ScreenCaptureStartOptions{}) &&
                   stub.lastError() == "unsupported_os",
               "unsupported stub start fails");
  ok &= expect(!stub.presentPicker(ScreenCaptureStartOptions{}) &&
                   stub.lastError() == "unsupported_os",
               "unsupported stub picker fails");

  stub.capabilitiesOverride.supported = true;
  stub.capabilitiesOverride.enumeration = true;
  stub.knownSourceIds = {"monitor:0x1", "window:0x2"};
  ok &= expect(stub.listSources().size() == 2u,
               "enumerating stub lists known ids");
  ScreenCaptureStartOptions startOptions;
  startOptions.maxWidth = 1280;
  startOptions.maxHeight = 720;
  startOptions.fps = 30;
  ok &= expect(stub.start("monitor:0x1", startOptions) &&
                   stub.status().running &&
                   stub.status().sourceId == "monitor:0x1" &&
                   !stub.lastStartReopened,
               "stub starts known source");
  ok &= expect(stub.start("monitor:0x1", startOptions) &&
                   !stub.lastStartReopened,
               "stub same-source start is idempotent");
  ok &= expect(stub.start("window:0x2", startOptions) &&
                   stub.lastStartReopened,
               "stub different-source start reopens");
  ok &= expect(!stub.start("monitor:0x3", startOptions) &&
                   stub.lastError() == "source_not_found",
               "stub rejects unknown source");

  stub.capabilitiesOverride.systemPicker = true;
  ok &= expect(stub.presentPicker(startOptions), "stub picker starts pending");
  ok &= expect(!stub.presentPicker(startOptions) &&
                   stub.lastError() == "picker_busy",
               "stub picker reports busy");
  VideoFrame frame;
  ok &= expect(!stub.copyLatestFrame(frame) &&
                   !stub.copyLatestFrameIfNew(0u, frame) &&
                   !stub.takeLatestFrameIfNew(0u, frame),
               "stub never returns frames");

  return ok ? 0 : 1;
}
