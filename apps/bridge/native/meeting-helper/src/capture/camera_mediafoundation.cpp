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
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <map>
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

// One MediaFoundation capture session (one per camera). The source reader runs
// in async callback mode (MF_SOURCE_READER_ASYNC_CALLBACK): OnReadSample stores
// the latest frame and immediately re-arms the next ReadSample, so no thread
// ever blocks inside ReadSample. That keeps stop() prompt even for a device
// that never delivers a frame (HDMI grabber without signal, NDI webcam without
// an active sender) -- the case that used to hang the sync reader's join.
//
// Lifetime: the reader holds a COM reference on the callback (async-callback
// attribute) and the callback holds the reader, so the pair stays alive while
// an async op can still fire. shutdown() clears running_, issues an async
// Flush and waits (bounded) for OnFlush; only then is the reader released --
// never from inside a callback (the reader's final release waits for its
// callback queue to drain, so releasing there would self-deadlock). The source
// reader serializes its callbacks, so OnFlush never runs mid-OnReadSample.
class MfReaderCallback final : public IMFSourceReaderCallback {
 public:
  MfReaderCallback() = default;

  // IUnknown --------------------------------------------------------------
  STDMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (ppv == nullptr) {
      return E_POINTER;
    }
    if (riid == IID_IUnknown || riid == __uuidof(IMFSourceReaderCallback)) {
      *ppv = static_cast<IMFSourceReaderCallback *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(refCount_.fetch_add(1) + 1);
  }
  STDMETHODIMP_(ULONG) Release() override {
    const long remaining = refCount_.fetch_sub(1) - 1;
    if (remaining == 0) {
      delete this;
    }
    return static_cast<ULONG>(remaining);
  }

  // Creates the device source + async reader and arms the first read. Runs on
  // the caller's MTA thread and only blocks for reader creation, never for a
  // frame. width/height/fps are accepted for contract parity with macOS; like
  // the previous sync implementation the reader keeps the negotiated native
  // RGB32 size. Returns false with initError() set on failure.
  bool open(const std::wstring &symbolicLink, uint32_t /*width*/,
            uint32_t /*height*/, uint32_t /*fps*/) {
    ComPtr<IMFSourceReader> reader;
    // Prefer the standard video processor; fall back to the advanced one, which
    // wraps the full DXVA video processor and handles more source formats.
    if (!initReader(symbolicLink, false, reader) &&
        !initReader(symbolicLink, true, reader)) {
      if (initError_.empty()) {
        initError_ = "Camera does not support an RGB32 output format.";
      }
      return false;
    }
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      reader_ = reader;
    }
    running_.store(true);
    const HRESULT hr = reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                                          0, nullptr, nullptr, nullptr, nullptr);
    if (FAILED(hr)) {
      running_.store(false);
      std::lock_guard<std::mutex> lock(stateMutex_);
      reader_.Reset();
      initError_ = "Could not start reading camera frames.";
      return false;
    }
    return true;
  }

  // Prompt, non-blocking-on-frames shutdown. Idempotent; callable from any
  // non-callback thread. The bounded wait is purely defensive -- Flush cancels
  // the pending ReadSample without waiting for data, so OnFlush normally
  // arrives within milliseconds even for a frameless device. On timeout the
  // reader/callback ref cycle keeps both alive until MF eventually completes
  // the flush (OnFlush then hands the reader to a detached releaser thread).
  void shutdown() {
    if (shutdownStarted_.exchange(true)) {
      return;
    }
    running_.store(false);
    ComPtr<IMFSourceReader> reader;
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      reader = reader_;
    }
    if (!reader) {
      return;
    }
    const HRESULT hr = reader->Flush(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
    std::unique_lock<std::mutex> lock(stateMutex_);
    if (FAILED(hr)) {
      // Flush could not be queued; the re-arm loop has stopped (running_ is
      // false), so release from here (a non-callback thread, which is safe).
      reader_.Reset();
      return;
    }
    if (flushCv_.wait_for(lock, std::chrono::seconds(2),
                          [this] { return flushCompleted_; })) {
      reader_.Reset();
    } else {
      abandoned_ = true;
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

  const std::string &initError() const { return initError_; }

  // IMFSourceReaderCallback -------------------------------------------------
  STDMETHODIMP OnReadSample(HRESULT hrStatus, DWORD /*streamIndex*/,
                            DWORD streamFlags, LONGLONG /*timestamp*/,
                            IMFSample *sample) override {
    if (FAILED(hrStatus) || (streamFlags & MF_SOURCE_READERF_ENDOFSTREAM)) {
      return S_OK;  // stream is done; stop re-arming.
    }
    ComPtr<IMFSourceReader> reader;
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      reader = reader_;
    }
    if (!reader) {
      return S_OK;
    }
    if (streamFlags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
      refreshFormat(reader.Get());
    }
    if (sample != nullptr) {
      processSample(sample);
    }
    // Re-arm. A shutdown() racing this re-arm is fine: its Flush cancels the
    // request we queue here, and a ReadSample failure simply ends the loop.
    if (running_.load()) {
      reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr,
                         nullptr, nullptr, nullptr);
    }
    return S_OK;
  }

  STDMETHODIMP OnFlush(DWORD /*streamIndex*/) override {
    ComPtr<IMFSourceReader> orphan;
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      flushCompleted_ = true;
      if (abandoned_) {
        orphan.Swap(reader_);
      }
    }
    flushCv_.notify_all();
    if (orphan) {
      // shutdown() gave up waiting; the reader must still not be released on
      // this (callback) thread, so hand it to a detached releaser.
      IMFSourceReader *raw = orphan.Detach();
      std::thread([raw] { raw->Release(); }).detach();
    }
    return S_OK;
  }

  STDMETHODIMP OnEvent(DWORD /*streamIndex*/, IMFMediaEvent * /*event*/) override {
    return S_OK;
  }

 private:
  ~MfReaderCallback() = default;  // COM-refcounted: delete only via Release().

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
    if (FAILED(MFCreateAttributes(&readerAttributes, 2))) {
      return false;
    }
    readerAttributes->SetUINT32(advancedProcessing
                                    ? MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING
                                    : MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
                                TRUE);
    // Async callback mode: the reader delivers frames via OnReadSample instead
    // of a blocking ReadSample, so a frameless device never stalls shutdown().
    if (FAILED(readerAttributes->SetUnknown(
            MF_SOURCE_READER_ASYNC_CALLBACK,
            static_cast<IMFSourceReaderCallback *>(this)))) {
      return false;
    }

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

  // Reads the negotiated frame size and stride. Touched by the opening thread
  // before the first read, then by OnReadSample only (the reader serializes its
  // callbacks, so at most one read is in flight), so the format fields need no
  // locking.
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

  std::atomic<long> refCount_{1};
  std::atomic<bool> running_{false};
  std::atomic<bool> shutdownStarted_{false};
  std::string initError_;

  // Guards reader_ / flushCompleted_ / abandoned_ (the shutdown handshake).
  std::mutex stateMutex_;
  std::condition_variable flushCv_;
  ComPtr<IMFSourceReader> reader_;
  bool flushCompleted_ = false;
  bool abandoned_ = false;

  // Format fields: opening thread before the first read, then OnReadSample only
  // (see refreshFormat).
  uint32_t frameWidth_ = 0;
  uint32_t frameHeight_ = 0;
  LONG stride_ = 0;

  mutable std::mutex frameMutex_;
  bool hasFrame_ = false;
  VideoFrame latestFrame_;
};

// One capture session as seen by the CameraSource facade. Thin owner of the
// COM-refcounted reader callback; instantiable more than once (conference mode
// holds one per open camera). stop() only quiesces the callback -- the object
// reference is intentionally kept so concurrent copyLatestFrame* readers on the
// program loop never race a pointer reset; it is dropped in the destructor, when
// the facade's last shared_ptr goes away.
class MfCaptureSession {
 public:
  ~MfCaptureSession() {
    stop();
    callback_.Reset();
  }

  // Blocks only for device/reader creation, never for a frame.
  bool open(const std::string &cameraId, uint32_t width, uint32_t height,
            uint32_t fps, std::string &errorOut) {
    ComPtr<MfReaderCallback> callback;
    callback.Attach(new MfReaderCallback());
    if (!callback->open(utf8ToWide(cameraId), width, height, fps)) {
      errorOut = callback->initError();
      return false;
    }
    callback_ = std::move(callback);
    return true;
  }

  void stop() {
    if (callback_) {
      callback_->shutdown();
    }
  }

  bool copyLatestFrame(VideoFrame &frame) {
    return callback_ ? callback_->copyLatestFrame(frame) : false;
  }

  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) {
    return callback_ ? callback_->copyLatestFrameIfNew(lastTimestampNs, frame)
                     : false;
  }

 private:
  ComPtr<MfReaderCallback> callback_;
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
    programIndex_ = cameraIndex;
    lastError_.clear();
    return true;
  }

  bool start(int cameraIndex, uint32_t width, uint32_t height,
             uint32_t fps) override {
    int resolvedIndex = cameraIndex;
    if (resolvedIndex < 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      resolvedIndex = programIndex_;
    }
    return startSet({resolvedIndex}, width, height, fps);
  }

  // Opens every requested camera at once (each on its own capture thread), so
  // conference mode can cut between them with no reopen. The program camera
  // starts as the first requested index that actually opened.
  bool startSet(const std::vector<int> &cameraIndices, uint32_t width,
                uint32_t height, uint32_t fps) override {
    ComApartment com;
    stop();
    if (cameraIndices.empty()) {
      setError("No cameras requested.");
      return false;
    }

    const std::vector<CameraInfo> cameras = listCameras();
    std::map<int, std::shared_ptr<MfCaptureSession>> opened;
    std::string lastOpenError;
    for (int requestedIndex : cameraIndices) {
      const CameraInfo *camera = findByIndex(cameras, requestedIndex);
      if (camera == nullptr) {
        lastOpenError = "Requested camera index is not available.";
        continue;
      }
      if (opened.count(camera->cameraIndex) != 0) {
        continue;  // de-dupe repeated indices.
      }
      auto session = std::make_shared<MfCaptureSession>();
      std::string error;
      if (!session->open(camera->cameraId, width, height, fps, error)) {
        lastOpenError = error.empty() ? "Could not start the camera." : error;
        continue;
      }
      opened[camera->cameraIndex] = std::move(session);
    }

    if (opened.empty()) {
      const bool denied =
          lowerAscii(lastOpenError).find("permission") != std::string::npos;
      setError(lastOpenError.empty() ? "No requested camera could be opened."
                                     : lastOpenError,
               denied ? "denied" : "");
      return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    sessions_ = std::move(opened);
    programIndex_ = sessions_.count(cameraIndices.front())
                        ? cameraIndices.front()
                        : sessions_.begin()->first;
    running_ = true;
    permissionStatus_ = "authorized";
    lastError_.clear();
    return true;
  }

  bool setProgramCamera(int cameraIndex) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (sessions_.count(cameraIndex) == 0) {
      lastError_ = "Requested program camera is not open.";
      return false;
    }
    // Seamless: every camera is already running; only the program pointer moves.
    programIndex_ = cameraIndex;
    lastError_.clear();
    return true;
  }

  std::vector<int> activeCameraSet() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<int> indices;
    indices.reserve(sessions_.size());
    for (const auto &entry : sessions_) {
      indices.push_back(entry.first);
    }
    return indices;
  }

  void stop() override {
    std::map<int, std::shared_ptr<MfCaptureSession>> sessions;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      sessions.swap(sessions_);
      running_ = false;
    }
    for (auto &entry : sessions) {
      if (entry.second) {
        entry.second->stop();  // outside the lock: joins the capture thread.
      }
    }
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_;
  }

  int activeCameraIndex() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_ ? programIndex_ : -1;
  }

  bool copyLatestFrame(VideoFrame &frame) override {
    const std::shared_ptr<MfCaptureSession> session = programSession();
    return session ? session->copyLatestFrame(frame) : false;
  }

  bool copyLatestFrameIfNew(uint64_t lastTimestampNs, VideoFrame &frame) override {
    const std::shared_ptr<MfCaptureSession> session = programSession();
    return session ? session->copyLatestFrameIfNew(lastTimestampNs, frame) : false;
  }

  // Reads a specific camera's latest frame (used for the conference PiP layer),
  // independent of which camera is currently the program.
  bool copyLatestFrameFrom(int cameraIndex, uint64_t lastTimestampNs,
                           VideoFrame &frame) override {
    const std::shared_ptr<MfCaptureSession> session = sessionFor(cameraIndex);
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
  std::shared_ptr<MfCaptureSession> programSession() const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = sessions_.find(programIndex_);
    return it == sessions_.end() ? nullptr : it->second;
  }

  std::shared_ptr<MfCaptureSession> sessionFor(int cameraIndex) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = sessions_.find(cameraIndex);
    return it == sessions_.end() ? nullptr : it->second;
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
  int programIndex_ = 0;
  std::string lastError_;
  // Windows has no camera prompt; startSet() flips this to "denied" only if the
  // global privacy setting blocks opening a device.
  std::string permissionStatus_ = "authorized";
  // One capture session per open camera index. Conference mode holds several and
  // cuts between them by moving programIndex_ (no reopen); meeting holds one.
  std::map<int, std::shared_ptr<MfCaptureSession>> sessions_;
};

}  // namespace

std::unique_ptr<CameraSource> createCameraSource() {
  return std::make_unique<MediaFoundationCameraSource>();
}

}  // namespace broadify::meeting

#endif
