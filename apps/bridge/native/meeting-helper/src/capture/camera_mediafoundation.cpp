#include "capture/camera_source.h"

#if defined(_WIN32)

#include "util/json_utils.h"

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfobjects.h>
#include <mferror.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace broadify::meeting {
namespace {

using Microsoft::WRL::ComPtr;

std::string lowerAscii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

bool isBroadifyVirtualCamera(const std::string &label, const std::string &cameraId) {
  const std::string haystack = lowerAscii(label + " " + cameraId);
  return haystack.find("com.broadify.vcam") != std::string::npos ||
         haystack.find("broadify camera") != std::string::npos ||
         haystack.find("broadify virtual camera") != std::string::npos;
}

std::string wideToUtf8(const wchar_t *value) {
  if (value == nullptr) {
    return {};
  }
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) {
    return {};
  }
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), size, nullptr, nullptr);
  return out;
}

std::wstring utf8ToWide(const std::string &value) {
  if (value.empty()) {
    return {};
  }
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  if (size <= 1) {
    return {};
  }
  std::wstring out(static_cast<size_t>(size - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, out.data(), size);
  return out;
}

bool isAccessDenied(HRESULT hr) {
  return hr == E_ACCESSDENIED ||
         hr == HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
}

// Per-thread COM apartment. MediaFoundation objects live in the MTA; every
// thread that touches them must initialize COM. Ref-counted by COM, so nesting
// on the same thread (e.g. start() calling listCameras()) is safe.
struct ComApartment {
  bool owns = false;
  ComApartment() {
    const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    owns = (hr == S_OK || hr == S_FALSE);
  }
  ~ComApartment() {
    if (owns) {
      CoUninitialize();
    }
  }
  ComApartment(const ComApartment &) = delete;
  ComApartment &operator=(const ComApartment &) = delete;
};

struct DeviceEntry {
  std::string cameraId;  // MF symbolic link (stable)
  std::string label;     // friendly name
};

// Enumerate video capture devices. Requires COM + MFStartup on the caller.
std::vector<DeviceEntry> enumerateDevices() {
  std::vector<DeviceEntry> result;
  ComPtr<IMFAttributes> attributes;
  if (FAILED(MFCreateAttributes(&attributes, 1))) {
    return result;
  }
  attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);

  IMFActivate **devices = nullptr;
  UINT32 count = 0;
  if (FAILED(MFEnumDeviceSources(attributes.Get(), &devices, &count))) {
    return result;
  }
  for (UINT32 i = 0; i < count; i++) {
    DeviceEntry entry;
    wchar_t *symbolicLink = nullptr;
    UINT32 linkLength = 0;
    if (SUCCEEDED(devices[i]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
            &symbolicLink, &linkLength))) {
      entry.cameraId = wideToUtf8(symbolicLink);
      CoTaskMemFree(symbolicLink);
    }
    wchar_t *friendlyName = nullptr;
    UINT32 nameLength = 0;
    if (SUCCEEDED(devices[i]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &friendlyName, &nameLength))) {
      entry.label = wideToUtf8(friendlyName);
      CoTaskMemFree(friendlyName);
    }
    if (!entry.cameraId.empty()) {
      result.push_back(std::move(entry));
    }
    devices[i]->Release();
  }
  CoTaskMemFree(devices);
  return result;
}

// BGRA (MF RGB32) -> tightly packed RGBA, forcing opaque alpha. scan0/pitch are
// already oriented top-down (pitch may be negative for a bottom-up source).
void swizzleBgraToRgba(const uint8_t *scan0, ptrdiff_t pitch, uint32_t width,
                       uint32_t height, std::vector<uint8_t> &destination) {
  destination.resize(static_cast<size_t>(width) * height * 4u);
  for (uint32_t y = 0; y < height; y++) {
    const uint8_t *src = scan0 + static_cast<ptrdiff_t>(y) * pitch;
    uint8_t *dst = destination.data() + static_cast<size_t>(y) * width * 4u;
    for (uint32_t x = 0; x < width; x++) {
      dst[0] = src[2];
      dst[1] = src[1];
      dst[2] = src[0];
      dst[3] = 255u;
      src += 4;
      dst += 4;
    }
  }
}

// One MediaFoundation capture session. Owns its source reader end-to-end on a
// dedicated capture thread so all MF object creation and use stays on a single
// MTA thread. Instantiable more than once (a future conference mode can hold
// several); the CameraSource facade keeps one active instance.
class MfCaptureSession {
 public:
  ~MfCaptureSession() { stop(); }

  // Blocks until the capture thread reports initialization success or failure.
  bool open(const std::string &cameraId, uint32_t width, uint32_t height,
            uint32_t fps, std::string &errorOut) {
    running_.store(true);
    std::promise<bool> initPromise;
    std::future<bool> initFuture = initPromise.get_future();
    thread_ = std::thread(&MfCaptureSession::run, this, utf8ToWide(cameraId),
                          width, height, fps, std::move(initPromise));
    const bool ok = initFuture.get();
    if (!ok) {
      errorOut = initError_;
      running_.store(false);
      if (thread_.joinable()) {
        thread_.join();
      }
    }
    return ok;
  }

  void stop() {
    running_.store(false);
    if (thread_.joinable()) {
      thread_.join();
    }
  }

  bool copyLatestFrame(VideoFrame &frame) {
    std::lock_guard<std::mutex> lock(frameMutex_);
    if (!hasFrame_) {
      return false;
    }
    frame = latestFrame_;
    return true;
  }

  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) {
    std::lock_guard<std::mutex> lock(frameMutex_);
    if (!hasFrame_ || latestFrame_.timestampNs == lastTimestampNs) {
      return false;
    }
    frame = latestFrame_;
    return true;
  }

 private:
  void run(std::wstring symbolicLink, uint32_t width, uint32_t height,
           uint32_t fps, std::promise<bool> initPromise) {
    ComApartment com;
    ComPtr<IMFSourceReader> reader;
    // Prefer the standard video processor; fall back to the advanced one, which
    // wraps the full DXVA video processor and handles more source formats.
    if (!initReader(symbolicLink, false, reader) &&
        !initReader(symbolicLink, true, reader)) {
      if (initError_.empty()) {
        initError_ = "Camera does not support an RGB32 output format.";
      }
      initPromise.set_value(false);
      return;
    }
    initPromise.set_value(true);

    while (running_.load()) {
      DWORD streamIndex = 0;
      DWORD flags = 0;
      LONGLONG timestamp = 0;
      ComPtr<IMFSample> sample;
      const HRESULT hr = reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                                            0, &streamIndex, &flags, &timestamp,
                                            &sample);
      if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) {
        break;
      }
      if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
        refreshFormat(reader.Get());
      }
      if (!sample) {
        continue;  // stream tick / gap; keep pumping.
      }
      processSample(sample.Get());
    }
  }

  bool initReader(const std::wstring &symbolicLink, bool advancedProcessing,
                  ComPtr<IMFSourceReader> &readerOut) {
    ComPtr<IMFAttributes> sourceAttributes;
    if (FAILED(MFCreateAttributes(&sourceAttributes, 2))) {
      return false;
    }
    sourceAttributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                              MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    sourceAttributes->SetString(
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
        symbolicLink.c_str());

    ComPtr<IMFMediaSource> source;
    HRESULT hr = MFCreateDeviceSource(sourceAttributes.Get(), &source);
    if (FAILED(hr)) {
      // Access denied is the Windows privacy gate; report it so the control
      // server surfaces camera_permission_denied.
      initError_ = isAccessDenied(hr)
                       ? "Camera permission was not granted (access denied)."
                       : "Could not open the camera device.";
      return false;
    }

    ComPtr<IMFAttributes> readerAttributes;
    if (FAILED(MFCreateAttributes(&readerAttributes, 1))) {
      return false;
    }
    readerAttributes->SetUINT32(advancedProcessing
                                    ? MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING
                                    : MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
                                TRUE);

    ComPtr<IMFSourceReader> reader;
    hr = MFCreateSourceReaderFromMediaSource(source.Get(), readerAttributes.Get(),
                                             &reader);
    if (FAILED(hr)) {
      initError_ = "Could not create a camera source reader.";
      return false;
    }

    reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
    reader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);

    ComPtr<IMFMediaType> outputType;
    if (FAILED(MFCreateMediaType(&outputType))) {
      return false;
    }
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    hr = reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr,
                                     outputType.Get());
    if (FAILED(hr)) {
      initError_ = "Camera does not support an RGB32 output format.";
      return false;
    }

    if (!refreshFormat(reader.Get())) {
      initError_ = "Could not read the negotiated camera format.";
      return false;
    }
    readerOut = reader;
    return true;
  }

  // Reads the negotiated frame size and stride. Runs on the capture thread only,
  // so the format fields need no locking.
  bool refreshFormat(IMFSourceReader *reader) {
    ComPtr<IMFMediaType> current;
    if (FAILED(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                                           &current))) {
      return false;
    }
    UINT32 width = 0;
    UINT32 height = 0;
    if (FAILED(MFGetAttributeSize(current.Get(), MF_MT_FRAME_SIZE, &width,
                                  &height)) ||
        width == 0 || height == 0) {
      return false;
    }
    LONG stride = 0;
    UINT32 storedStride = 0;
    if (SUCCEEDED(current->GetUINT32(MF_MT_DEFAULT_STRIDE, &storedStride))) {
      stride = static_cast<LONG>(static_cast<INT32>(storedStride));
    } else {
      stride = static_cast<LONG>(width) * 4;  // RGB32 default, top-down.
    }
    frameWidth_ = width;
    frameHeight_ = height;
    stride_ = stride;
    return true;
  }

  void processSample(IMFSample *sample) {
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) {
      return;
    }

    VideoFrame frame;
    frame.width = frameWidth_;
    frame.height = frameHeight_;
    frame.timestampNs = nowNs();

    bool converted = false;
    // Preferred path: the 2D buffer reports the real pitch (rows may be padded)
    // and points at the top row (negative pitch for a bottom-up source).
    ComPtr<IMF2DBuffer2> buffer2d;
    if (SUCCEEDED(buffer.As(&buffer2d))) {
      BYTE *scanline0 = nullptr;
      LONG pitch = 0;
      BYTE *bufferStart = nullptr;
      DWORD bufferLength = 0;
      if (SUCCEEDED(buffer2d->Lock2DSize(MF2DBuffer_LockFlags_Read, &scanline0,
                                         &pitch, &bufferStart, &bufferLength))) {
        swizzleBgraToRgba(scanline0, pitch, frameWidth_, frameHeight_, frame.rgba);
        buffer2d->Unlock2D();
        converted = true;
      }
    }

    // Fallback: a flat buffer. Apply the bottom-up flip manually using the
    // negotiated stride sign; the target frame is always top-down and packed.
    if (!converted) {
      BYTE *data = nullptr;
      DWORD length = 0;
      if (SUCCEEDED(buffer->Lock(&data, nullptr, &length))) {
        const LONG absStride = stride_ < 0 ? -stride_ : stride_;
        const LONG rowStride = absStride != 0 ? absStride
                                              : static_cast<LONG>(frameWidth_) * 4;
        const size_t required = static_cast<size_t>(rowStride) * frameHeight_;
        if (length >= required) {
          const uint8_t *scanline0 =
              stride_ < 0 ? data + static_cast<size_t>(frameHeight_ - 1) * rowStride
                          : data;
          const ptrdiff_t pitch = stride_ < 0 ? -rowStride : rowStride;
          swizzleBgraToRgba(scanline0, pitch, frameWidth_, frameHeight_,
                            frame.rgba);
          converted = true;
        }
        buffer->Unlock();
      }
    }

    if (!converted) {
      return;
    }
    std::lock_guard<std::mutex> lock(frameMutex_);
    latestFrame_ = std::move(frame);
    hasFrame_ = true;
  }

  std::thread thread_;
  std::atomic<bool> running_{false};
  std::string initError_;

  // Format fields are touched only by the capture thread.
  uint32_t frameWidth_ = 0;
  uint32_t frameHeight_ = 0;
  LONG stride_ = 0;

  mutable std::mutex frameMutex_;
  bool hasFrame_ = false;
  VideoFrame latestFrame_;
};

class MediaFoundationCameraSource final : public CameraSource {
 public:
  MediaFoundationCameraSource() { mfStarted_ = SUCCEEDED(MFStartup(MF_VERSION)); }

  ~MediaFoundationCameraSource() override {
    stop();
    if (mfStarted_) {
      MFShutdown();
    }
  }

  std::vector<CameraInfo> listCameras() override {
    ComApartment com;
    const std::vector<DeviceEntry> devices = enumerateDevices();

    std::vector<CameraInfo> cameras;
    int index = 0;
    for (const DeviceEntry &device : devices) {
      if (isBroadifyVirtualCamera(device.label, device.cameraId)) {
        continue;  // never capture our own virtual camera -> feedback loop.
      }
      const std::string lowered = lowerAscii(device.label);
      CameraInfo info;
      info.cameraIndex = index++;
      info.label = device.label;
      info.cameraId = device.cameraId;
      info.displayName = device.label;
      info.stableKey = device.cameraId;
      info.backend = "mediafoundation";
      info.deviceName = device.label;
      info.builtinCandidate = lowered.find("integrated") != std::string::npos ||
                              lowered.find("built-in") != std::string::npos;
      info.virtualCandidate = lowered.find("virtual") != std::string::npos ||
                              lowered.find("obs") != std::string::npos;
      info.continuityCandidate = false;
      info.available = true;
      info.active = isRunning() && activeCameraIndex() == info.cameraIndex;
      cameras.push_back(std::move(info));
    }
    setError("");
    return cameras;
  }

  bool selectCamera(int cameraIndex) override {
    const std::vector<CameraInfo> cameras = listCameras();
    if (!findByIndex(cameras, cameraIndex)) {
      setError("Requested camera index is not available.");
      return false;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    selectedIndex_ = cameraIndex;
    lastError_.clear();
    return true;
  }

  bool start(int cameraIndex, uint32_t width, uint32_t height,
             uint32_t fps) override {
    ComApartment com;
    stop();

    const std::vector<CameraInfo> cameras = listCameras();
    int resolvedIndex = cameraIndex;
    if (resolvedIndex < 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      resolvedIndex = selectedIndex_;
    }
    const CameraInfo *camera = findByIndex(cameras, resolvedIndex);
    if (camera == nullptr) {
      setError("Requested camera index is not available.");
      return false;
    }

    auto session = std::make_shared<MfCaptureSession>();
    std::string error;
    if (!session->open(camera->cameraId, width, height, fps, error)) {
      const bool denied = lowerAscii(error).find("permission") != std::string::npos;
      setError(error.empty() ? "Could not start the camera." : error,
               denied ? "denied" : "");
      return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    session_ = std::move(session);
    selectedIndex_ = camera->cameraIndex;
    running_ = true;
    permissionStatus_ = "authorized";
    lastError_.clear();
    return true;
  }

  void stop() override {
    std::shared_ptr<MfCaptureSession> session;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = std::move(session_);
      session_.reset();
      running_ = false;
    }
    if (session) {
      session->stop();  // outside the lock: joins the capture thread.
    }
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_;
  }

  int activeCameraIndex() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_ ? selectedIndex_ : -1;
  }

  bool copyLatestFrame(VideoFrame &frame) override {
    const std::shared_ptr<MfCaptureSession> session = activeSession();
    return session ? session->copyLatestFrame(frame) : false;
  }

  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override {
    const std::shared_ptr<MfCaptureSession> session = activeSession();
    return session ? session->copyLatestFrameIfNew(lastTimestampNs, frame) : false;
  }

  std::string lastError() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastError_;
  }

  std::string cameraPermissionStatus() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return permissionStatus_;
  }

  // Windows has no per-app camera prompt for unpackaged Win32 apps; access is
  // governed by the global privacy setting and only surfaces as an access-denied
  // HRESULT when a device is actually opened (see start()). There is no
  // "not_determined"/prompt state to resolve on Windows, so report authorized up
  // front; a real denial is reported by start() when it opens the device. This
  // keeps the bridge's macOS-style permission gate from blocking camera.list.
  std::string requestCameraPermission() override {
    setPermissionStatus("authorized");
    return "authorized";
  }

 private:
  std::shared_ptr<MfCaptureSession> activeSession() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return session_;
  }

  static const CameraInfo *findByIndex(const std::vector<CameraInfo> &cameras,
                                       int cameraIndex) {
    const auto match = std::find_if(
        cameras.begin(), cameras.end(),
        [cameraIndex](const CameraInfo &info) {
          return info.cameraIndex == cameraIndex;
        });
    return match == cameras.end() ? nullptr : &(*match);
  }

  void setPermissionStatus(const std::string &status) {
    std::lock_guard<std::mutex> lock(mutex_);
    permissionStatus_ = status;
  }

  void setError(const std::string &error, const std::string &permissionStatus = "") {
    std::lock_guard<std::mutex> lock(mutex_);
    lastError_ = error;
    if (!permissionStatus.empty()) {
      permissionStatus_ = permissionStatus;
    }
  }

  mutable std::mutex mutex_;
  bool mfStarted_ = false;
  bool running_ = false;
  int selectedIndex_ = 0;
  std::string lastError_;
  // Windows has no camera prompt; start() flips this to "denied" only if the
  // global privacy setting blocks opening a device.
  std::string permissionStatus_ = "authorized";
  std::shared_ptr<MfCaptureSession> session_;
};

}  // namespace

std::unique_ptr<CameraSource> createCameraSource() {
  return std::make_unique<MediaFoundationCameraSource>();
}

}  // namespace broadify::meeting

#endif
