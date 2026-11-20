// Windows UVC backend of the PGM helper (ADR-0009): Media Foundation source
// reader in asynchronous callback mode, the Windows counterpart of
// uvc_avfoundation.mm. Frames reach the engine in the device's own pixel
// layout (NV12, YUY2, UYVY) as planes in CPU memory; the reader is created
// without its video processor, so nothing is converted or scaled behind our
// back. MJPG is the one exception: when the highest mode is only offered
// compressed, the reader's decoder is asked for NV12 (YUY2 as fallback) and the
// signal reports "decode":"mjpg".
//
// Device enumeration, the callback lifetime and the flush handshake follow
// meeting-helper/src/capture/camera_mediafoundation.cpp.

#if defined(_WIN32)

#include "capture/uvc_format_select.h"
#include "capture/video_source.h"

#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"
#include "helper_common/path_utf8.h"
#include "live_stream/monotonic_clock.h"
#include "live_stream/nv12_layout.h"

#include <windows.h>

#include <cfgmgr32.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace broadify::pgm {
namespace {

using Microsoft::WRL::ComPtr;
using broadify::helper::emitHelperEvent;
using broadify::helper::jsonEscape;
using broadify::helper::utf8ToWide;
using broadify::helper::wideToUtf8;

// How long start() waits for the first sample or the first error. A camera
// another application holds fails within this window on the first read, so the
// caller gets `device_in_use` as the answer instead of a preview that never
// shows a picture. A device that is merely slow still starts: the wait ends
// without a verdict and later errors arrive as `pgm_capture_error` events,
// a first read that fails only after the wait included.
constexpr auto kFirstSampleWait = std::chrono::milliseconds(750);
// Device arrival/removal comes as a burst of interface notifications.
constexpr auto kHotPlugDebounce = std::chrono::milliseconds(300);

// KSCATEGORY_VIDEO_CAMERA and KSCATEGORY_VIDEO (ks.h / ksmedia.h), spelled out
// so this file needs no kernel streaming headers.
const GUID kCategoryVideoCamera = {0xe5323777, 0xf976, 0x4f5b, {0x9b, 0x55, 0xb9, 0x46, 0x99, 0xc4, 0x6e, 0x44}};
const GUID kCategoryVideo = {0x6994ad05, 0x93ef, 0x11d0, {0xa3, 0xcc, 0x00, 0xa0, 0xc9, 0x22, 0x31, 0x96}};

std::string lowerAscii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(ch >= 'A' && ch <= 'Z' ? ch - 'A' + 'a' : ch);
  });
  return value;
}

bool isBroadifyVirtualCamera(const std::string &name, const std::string &deviceId) {
  const std::string haystack = lowerAscii(name + " " + deviceId);
  return haystack.find("com.broadify.vcam") != std::string::npos || haystack.find("broadify camera") != std::string::npos ||
         haystack.find("broadify virtual camera") != std::string::npos;
}

std::string hresultHex(HRESULT hr) {
  std::ostringstream out;
  out << "0x" << std::hex << std::uppercase << static_cast<uint32_t>(hr);
  return out.str();
}

// Per-thread COM apartment. Media Foundation objects live in the MTA; every
// thread that touches them initializes COM (ref-counted, so nesting is safe).
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
  std::string symbolicLink;  // device interface path, as Media Foundation spells it
  std::string name;          // friendly name
};

// Video capture devices. Requires COM + MFStartup (platform host) on the caller.
std::vector<DeviceEntry> enumerateDevices(HRESULT &result) {
  std::vector<DeviceEntry> entries;
  ComPtr<IMFAttributes> attributes;
  result = MFCreateAttributes(&attributes, 1);
  if (FAILED(result)) {
    return entries;
  }
  attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  IMFActivate **devices = nullptr;
  UINT32 count = 0;
  result = MFEnumDeviceSources(attributes.Get(), &devices, &count);
  if (FAILED(result)) {
    return entries;
  }
  for (UINT32 index = 0; index < count; ++index) {
    DeviceEntry entry;
    wchar_t *symbolicLink = nullptr;
    UINT32 linkLength = 0;
    if (SUCCEEDED(devices[index]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &symbolicLink, &linkLength))) {
      entry.symbolicLink = wideToUtf8(symbolicLink);
      CoTaskMemFree(symbolicLink);
    }
    wchar_t *friendlyName = nullptr;
    UINT32 nameLength = 0;
    if (SUCCEEDED(devices[index]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &friendlyName, &nameLength))) {
      entry.name = wideToUtf8(friendlyName);
      CoTaskMemFree(friendlyName);
    }
    if (!entry.symbolicLink.empty()) {
      entries.push_back(std::move(entry));
    }
    devices[index]->Release();
  }
  CoTaskMemFree(devices);
  return entries;
}

UvcSubtype subtypeOf(const GUID &subtype) {
  if (IsEqualGUID(subtype, MFVideoFormat_NV12)) {
    return UvcSubtype::Nv12;
  }
  if (IsEqualGUID(subtype, MFVideoFormat_YUY2)) {
    return UvcSubtype::Yuy2;
  }
  if (IsEqualGUID(subtype, MFVideoFormat_UYVY)) {
    return UvcSubtype::Uyvy;
  }
  if (IsEqualGUID(subtype, MFVideoFormat_MJPG)) {
    return UvcSubtype::Mjpg;
  }
  return UvcSubtype::Other;
}

// Name for the mode list in the event log: our own names for what we can use,
// the FourCC for everything else (H264, I420, ...).
std::string subtypeLabel(const GUID &subtype) {
  const UvcSubtype known = subtypeOf(subtype);
  if (known != UvcSubtype::Other) {
    return uvcSubtypeName(known);
  }
  std::string fourcc;
  for (int shift = 0; shift < 32; shift += 8) {
    const char ch = static_cast<char>((subtype.Data1 >> shift) & 0xff);
    if (ch < 0x20 || ch > 0x7e || ch == '"' || ch == '\\') {
      return "other";
    }
    fourcc.push_back(ch);
  }
  return lowerAscii(fourcc);
}

struct NativeMode {
  ComPtr<IMFMediaType> type;
  UvcFormatCandidate candidate;
  std::string label;
};

std::vector<NativeMode> nativeModes(IMFSourceReader *reader) {
  std::vector<NativeMode> modes;
  for (DWORD index = 0; index < 4096; ++index) {
    ComPtr<IMFMediaType> type;
    const HRESULT hr = reader->GetNativeMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), index, &type);
    if (FAILED(hr)) {
      break;  // MF_E_NO_MORE_TYPES ends the list
    }
    GUID major{};
    GUID subtype{};
    UINT32 width = 0;
    UINT32 height = 0;
    if (FAILED(type->GetGUID(MF_MT_MAJOR_TYPE, &major)) || !IsEqualGUID(major, MFMediaType_Video) ||
        FAILED(type->GetGUID(MF_MT_SUBTYPE, &subtype)) || FAILED(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height))) {
      continue;
    }
    UINT32 fpsNum = 0;
    UINT32 fpsDen = 0;
    MFGetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, &fpsNum, &fpsDen);
    NativeMode mode;
    mode.type = type;
    mode.candidate.width = width;
    mode.candidate.height = height;
    mode.candidate.fpsNum = fpsNum;
    mode.candidate.fpsDen = fpsDen;
    mode.candidate.subtype = subtypeOf(subtype);
    mode.label = subtypeLabel(subtype);
    modes.push_back(std::move(mode));
  }
  return modes;
}

std::string modeJson(const NativeMode &mode) {
  std::ostringstream out;
  out << "{\"width\":" << mode.candidate.width << ",\"height\":" << mode.candidate.height << ",\"fps_num\":" << mode.candidate.fpsNum
      << ",\"fps_den\":" << mode.candidate.fpsDen << ",\"subtype\":\"" << jsonEscape(mode.label) << "\"}";
  return out.str();
}

// Capture time on the helper's monotonic clock (monotonic_clock.h; on Windows
// std::steady_clock, i.e. the performance counter). The device timestamp of
// the sample is on that same counter; it is used when it is plausible (not in
// the future, less than a second old), the arrival time otherwise.
uint64_t captureTimeNs(IMFSample *sample) {
  const uint64_t now = monotonicNowNs();
  UINT64 deviceTime100ns = 0;
  if (SUCCEEDED(sample->GetUINT64(MFSampleExtension_DeviceTimestamp, &deviceTime100ns))) {
    const uint64_t deviceNs = static_cast<uint64_t>(deviceTime100ns) * 100ULL;
    if (deviceNs <= now && now - deviceNs < 1'000'000'000ULL) {
      return deviceNs;
    }
  }
  return now;
}

// The pixels of one media buffer, locked for reading. Prefers the 2D
// interfaces: they report the real pitch (rows may be padded) without a copy.
// The flat Lock hands out the picture at the media type's default stride.
class LockedPixels {
 public:
  LockedPixels(IMFMediaBuffer *buffer, LONG defaultStride) : buffer_(buffer) {
    if (SUCCEEDED(buffer_.As(&buffer2d2_))) {
      BYTE *scanline0 = nullptr;
      LONG pitch = 0;
      BYTE *start = nullptr;
      DWORD length = 0;
      if (SUCCEEDED(buffer2d2_->Lock2DSize(MF2DBuffer_LockFlags_Read, &scanline0, &pitch, &start, &length))) {
        mode_ = Mode::TwoD2;
        if (scanline0 != nullptr && start != nullptr && scanline0 >= start && static_cast<size_t>(scanline0 - start) <= length) {
          data_ = scanline0;
          pitch_ = pitch;
          available_ = static_cast<size_t>(length) - static_cast<size_t>(scanline0 - start);
        }
        return;
      }
      buffer2d2_.Reset();
    }
    if (SUCCEEDED(buffer_.As(&buffer2d_))) {
      BYTE *scanline0 = nullptr;
      LONG pitch = 0;
      if (SUCCEEDED(buffer2d_->Lock2D(&scanline0, &pitch))) {
        mode_ = Mode::TwoD;
        data_ = scanline0;
        pitch_ = pitch;
        available_ = 0;  // not reported by this interface
        return;
      }
      buffer2d_.Reset();
    }
    BYTE *data = nullptr;
    DWORD length = 0;
    if (SUCCEEDED(buffer_->Lock(&data, nullptr, &length))) {
      mode_ = Mode::Flat;
      data_ = data;
      pitch_ = defaultStride;
      available_ = length;
    }
  }

  ~LockedPixels() {
    switch (mode_) {
      case Mode::TwoD2: buffer2d2_->Unlock2D(); break;
      case Mode::TwoD: buffer2d_->Unlock2D(); break;
      case Mode::Flat: buffer_->Unlock(); break;
      case Mode::None: break;
    }
  }

  LockedPixels(const LockedPixels &) = delete;
  LockedPixels &operator=(const LockedPixels &) = delete;

  /** Top row; nullptr when the buffer could not be locked. */
  const uint8_t *data() const { return data_; }
  /** Bytes per row; YUV pictures are top-down, so anything <= 0 is unusable. */
  LONG pitch() const { return pitch_; }
  /** Bytes readable from data(); 0 when the interface does not say. */
  size_t available() const { return available_; }
  bool flat() const { return mode_ == Mode::Flat; }

 private:
  enum class Mode { None, TwoD2, TwoD, Flat };
  ComPtr<IMFMediaBuffer> buffer_;
  ComPtr<IMF2DBuffer2> buffer2d2_;
  ComPtr<IMF2DBuffer> buffer2d_;
  Mode mode_ = Mode::None;
  const uint8_t *data_ = nullptr;
  LONG pitch_ = 0;
  size_t available_ = 0;
};

// One capture session. COM object: the reader holds a reference on its
// callback and the callback holds the reader, so the pair stays alive while an
// asynchronous operation can still fire. shutdown() stops the re-arm loop,
// flushes and waits (bounded) for OnFlush; the reader is released afterwards,
// never from inside a callback (its final release waits for the callback queue).
class UvcSession final : public IMFSourceReaderCallback {
 public:
  explicit UvcSession(std::string displayName) : displayName_(std::move(displayName)) {}

  // IUnknown ----------------------------------------------------------------
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
  STDMETHODIMP_(ULONG) AddRef() override { return static_cast<ULONG>(refCount_.fetch_add(1) + 1); }
  STDMETHODIMP_(ULONG) Release() override {
    const long remaining = refCount_.fetch_sub(1) - 1;
    if (remaining == 0) {
      delete this;
    }
    return static_cast<ULONG>(remaining);
  }

  // Opens the device, negotiates the mode and arms the first read. Blocks for
  // device and reader creation and at most kFirstSampleWait for the first
  // sample or error.
  bool open(const std::wstring &symbolicLink, FrameSink sink, std::string &errorCode, std::string &error) {
    {
      std::lock_guard<std::mutex> lock(sinkMutex_);
      sink_ = std::move(sink);
    }
    ComPtr<IMFAttributes> sourceAttributes;
    HRESULT hr = MFCreateAttributes(&sourceAttributes, 2);
    if (FAILED(hr)) {
      return failOpen(hr, "Could not prepare the video input", errorCode, error);
    }
    sourceAttributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    sourceAttributes->SetString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, symbolicLink.c_str());
    ComPtr<IMFMediaSource> source;
    hr = MFCreateDeviceSource(sourceAttributes.Get(), &source);
    if (FAILED(hr)) {
      return failOpen(hr, "Could not open the video input", errorCode, error);
    }

    ComPtr<IMFAttributes> readerAttributes;
    hr = MFCreateAttributes(&readerAttributes, 2);
    if (SUCCEEDED(hr)) {
      // No video processor (MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING stays
      // unset): the device's own layout goes to the engine untouched.
      readerAttributes->SetUINT32(MF_LOW_LATENCY, TRUE);
      hr = readerAttributes->SetUnknown(MF_SOURCE_READER_ASYNC_CALLBACK, static_cast<IMFSourceReaderCallback *>(this));
    }
    ComPtr<IMFSourceReader> reader;
    if (SUCCEEDED(hr)) {
      hr = MFCreateSourceReaderFromMediaSource(source.Get(), readerAttributes.Get(), &reader);
    }
    if (FAILED(hr)) {
      source->Shutdown();
      return failOpen(hr, "Could not create the source reader for the video input", errorCode, error);
    }
    reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE);
    reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), TRUE);

    if (!negotiate(reader.Get(), errorCode, error)) {
      reader.Reset();
      source->Shutdown();
      return false;
    }

    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      reader_ = reader;
      source_ = source;
    }
    running_.store(true);
    hr = reader->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0, nullptr, nullptr, nullptr, nullptr);
    if (FAILED(hr)) {
      shutdown();
      return failOpen(hr, "Could not start reading from the video input", errorCode, error);
    }

    HRESULT firstResult = S_OK;
    {
      std::unique_lock<std::mutex> lock(stateMutex_);
      firstCv_.wait_for(lock, kFirstSampleWait, [this] { return firstSeen_; });
      // Set under the lock OnReadSample decides under: a first result is
      // either seen here (and answered by this call) or arrives after this
      // point and is reported by the callback, never both and never neither.
      firstWaitOver_ = true;
      firstResult = firstSeen_ ? firstResult_ : S_OK;
    }
    if (FAILED(firstResult)) {
      shutdown();
      return failOpen(firstResult, "The video input did not start", errorCode, error);
    }
    return true;
  }

  // Idempotent; callable from any non-callback thread. Flush cancels the
  // pending read without waiting for data, so OnFlush normally arrives within
  // milliseconds; on timeout the reader is handed to a releaser thread once
  // the flush completes.
  void shutdown() {
    if (shutdownStarted_.exchange(true)) {
      return;
    }
    running_.store(false);
    {
      std::lock_guard<std::mutex> lock(sinkMutex_);
      sink_ = nullptr;
    }
    ComPtr<IMFSourceReader> reader;
    ComPtr<IMFMediaSource> source;
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      reader = reader_;
      source = source_;
      source_.Reset();
    }
    if (reader) {
      const HRESULT hr = reader->Flush(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM));
      ComPtr<IMFSourceReader> released;
      {
        std::unique_lock<std::mutex> lock(stateMutex_);
        if (FAILED(hr) || flushCv_.wait_for(lock, std::chrono::seconds(2), [this] { return flushCompleted_; })) {
          released.Swap(reader_);
        } else {
          abandoned_ = true;
        }
      }
      // Both references go outside the lock: the final release of the reader
      // waits for its callback queue.
      reader.Reset();
      released.Reset();
    }
    if (source) {
      // Frees the device for other applications now rather than with the last reference.
      source->Shutdown();
    }
  }

  bool running() const { return running_.load(); }
  bool decodesMjpg() const { return decodesMjpg_.load(); }

  // IMFSourceReaderCallback -------------------------------------------------
  STDMETHODIMP OnReadSample(HRESULT hrStatus, DWORD /*streamIndex*/, DWORD streamFlags, LONGLONG /*timestamp*/,
                            IMFSample *sample) override {
    const bool ended = (streamFlags & MF_SOURCE_READERF_ENDOFSTREAM) != 0;
    const bool failed = FAILED(hrStatus) || (streamFlags & MF_SOURCE_READERF_ERROR) != 0 || ended;
    const HRESULT result = FAILED(hrStatus) ? hrStatus : (failed ? HRESULT_FROM_WIN32(ERROR_HANDLE_EOF) : S_OK);
    bool first = false;
    bool answeredByOpen = false;
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      if (!firstSeen_ && (failed || sample != nullptr)) {
        firstSeen_ = true;
        firstResult_ = result;
        first = true;
        // open() takes the first result as its own answer only while it still waits for it.
        answeredByOpen = !firstWaitOver_;
      }
    }
    if (first) {
      firstCv_.notify_all();
    }
    if (failed) {
      running_.store(false);
      // A first failure open() still waits for fails the open itself. One that
      // arrives after open() stopped waiting (a slow device) is a capture
      // error like any later one.
      if (!answeredByOpen) {
        notifyCaptureError(result, ended ? "end_of_stream" : "read_sample_failed");
      }
      return S_OK;
    }
    ComPtr<IMFSourceReader> reader;
    {
      std::lock_guard<std::mutex> lock(stateMutex_);
      reader = reader_;
    }
    if (!reader) {
      return S_OK;
    }
    if (streamFlags & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED | MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED)) {
      refreshFormat(reader.Get());
    }
    if (sample != nullptr && running_.load()) {
      deliver(sample);
    }
    // Re-arm. A shutdown() racing this is fine: its Flush cancels the request.
    if (running_.load()) {
      reader->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0, nullptr, nullptr, nullptr, nullptr);
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
      // this (callback) thread.
      IMFSourceReader *raw = orphan.Detach();
      std::thread([raw] { raw->Release(); }).detach();
    }
    return S_OK;
  }

  STDMETHODIMP OnEvent(DWORD /*streamIndex*/, IMFMediaEvent *event) override {
    if (event == nullptr) {
      return S_OK;
    }
    MediaEventType type = MEUnknown;
    HRESULT status = S_OK;
    event->GetType(&type);
    event->GetStatus(&status);
    if (type == MEVideoCaptureDeviceRemoved || type == MEError || FAILED(status)) {
      running_.store(false);
      notifyCaptureError(FAILED(status) ? status : HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED),
                         type == MEVideoCaptureDeviceRemoved ? "device_removed" : "media_event_error");
    }
    return S_OK;
  }

 private:
  ~UvcSession() = default;  // COM-refcounted: delete only via Release().

  bool failOpen(HRESULT hr, const char *what, std::string &errorCode, std::string &error) {
    errorCode = uvcOpenErrorCode(static_cast<uint32_t>(hr));
    error = std::string(what) + " (" + hresultHex(hr) + ").";
    if (errorCode == "camera_permission_denied") {
      error = "Camera access is denied by the Windows privacy settings (" + hresultHex(hr) + ").";
    }
    return false;
  }

  // Picks the device mode and brings the reader to an output we can deliver.
  // A mode the reader refuses is dropped and the next best one tried.
  bool negotiate(IMFSourceReader *reader, std::string &errorCode, std::string &error) {
    std::vector<NativeMode> modes = nativeModes(reader);
    {
      std::string json = "{\"type\":\"pgm_uvc_modes\",\"device\":\"" + jsonEscape(displayName_) + "\",\"count\":" +
                         std::to_string(modes.size()) + ",\"modes\":[";
      // Enough for any switcher or webcam; the count above tells when the list was cut.
      const size_t listed = std::min<size_t>(modes.size(), 96);
      for (size_t index = 0; index < listed; ++index) {
        json += (index == 0 ? "" : ",") + modeJson(modes[index]);
      }
      emitHelperEvent(json + "]}");
    }
    std::vector<UvcFormatCandidate> candidates;
    candidates.reserve(modes.size());
    for (const NativeMode &mode : modes) {
      candidates.push_back(mode.candidate);
    }
    HRESULT lastHr = MF_E_INVALIDMEDIATYPE;
    for (size_t attempt = 0; attempt <= candidates.size(); ++attempt) {
      const int choice = selectUvcFormat(candidates);
      if (choice < 0) {
        break;
      }
      const NativeMode &mode = modes[static_cast<size_t>(choice)];
      const bool mjpg = mode.candidate.subtype == UvcSubtype::Mjpg;
      HRESULT hr = reader->SetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), nullptr, mode.type.Get());
      if (SUCCEEDED(hr) && mjpg) {
        // The reader inserts the MJPG decoder for an uncompressed output type.
        hr = requestDecodedOutput(reader, mode, MFVideoFormat_NV12);
        if (FAILED(hr)) {
          hr = requestDecodedOutput(reader, mode, MFVideoFormat_YUY2);
        }
      }
      if (SUCCEEDED(hr) && !refreshFormat(reader)) {
        hr = MF_E_INVALIDMEDIATYPE;
      }
      if (SUCCEEDED(hr)) {
        decodesMjpg_.store(mjpg);
        std::ostringstream event;
        event << "{\"type\":\"pgm_uvc_mode_selected\",\"device\":\"" << jsonEscape(displayName_) << "\",\"mode\":" << modeJson(mode)
              << ",\"delivered\":\"" << pixelFormat_ << "\",\"decode\":" << (mjpg ? "\"mjpg\"" : "null") << "}";
        emitHelperEvent(event.str());
        return true;
      }
      lastHr = hr;
      emitHelperEvent("{\"type\":\"pgm_uvc_mode_rejected\",\"device\":\"" + jsonEscape(displayName_) + "\",\"mode\":" + modeJson(mode) +
                      ",\"hr\":\"" + hresultHex(hr) + "\"}");
      candidates[static_cast<size_t>(choice)].subtype = UvcSubtype::Other;  // never again
    }
    errorCode = "unsupported_format";
    error = modes.empty() ? "The device offers no video format."
                          : "The device offers no usable video format (up to 1080p; NV12, YUY2, UYVY or MJPG; last result " +
                                hresultHex(lastHr) + ").";
    return false;
  }

  HRESULT requestDecodedOutput(IMFSourceReader *reader, const NativeMode &mode, const GUID &subtype) {
    ComPtr<IMFMediaType> output;
    HRESULT hr = MFCreateMediaType(&output);
    if (FAILED(hr)) {
      return hr;
    }
    output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    output->SetGUID(MF_MT_SUBTYPE, subtype);
    MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, mode.candidate.width, mode.candidate.height);
    if (mode.candidate.fpsNum > 0 && mode.candidate.fpsDen > 0) {
      MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, mode.candidate.fpsNum, mode.candidate.fpsDen);
    }
    return reader->SetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), nullptr, output.Get());
  }

  // Reads what the reader delivers now. Touched by the opening thread before
  // the first read, then by OnReadSample only (the reader serializes its
  // callbacks), so the format fields need no lock.
  bool refreshFormat(IMFSourceReader *reader) {
    ComPtr<IMFMediaType> current;
    if (FAILED(reader->GetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), &current))) {
      return false;
    }
    GUID subtype{};
    UINT32 width = 0;
    UINT32 height = 0;
    if (FAILED(current->GetGUID(MF_MT_SUBTYPE, &subtype)) || FAILED(MFGetAttributeSize(current.Get(), MF_MT_FRAME_SIZE, &width, &height)) ||
        width == 0 || height == 0) {
      return false;
    }
    const UvcSubtype delivered = subtypeOf(subtype);
    if (delivered != UvcSubtype::Nv12 && delivered != UvcSubtype::Yuy2 && delivered != UvcSubtype::Uyvy) {
      return false;
    }
    LONG stride = 0;
    UINT32 storedStride = 0;
    if (SUCCEEDED(current->GetUINT32(MF_MT_DEFAULT_STRIDE, &storedStride))) {
      stride = static_cast<LONG>(static_cast<INT32>(storedStride));
    } else if (FAILED(MFGetStrideForBitmapInfoHeader(subtype.Data1, width, &stride))) {
      stride = 0;
    }
    if (stride <= 0) {
      stride = static_cast<LONG>(delivered == UvcSubtype::Nv12 ? width : width * 2);
    }
    width_ = width;
    height_ = height;
    nv12_ = delivered == UvcSubtype::Nv12;
    pixelFormat_ = uvcSubtypeName(delivered);
    defaultStride_ = stride;
    return true;
  }

  void deliver(IMFSample *sample) {
    DWORD bufferCount = 0;
    if (FAILED(sample->GetBufferCount(&bufferCount)) || bufferCount == 0) {
      return;
    }
    ComPtr<IMFMediaBuffer> buffer;
    const HRESULT hr = bufferCount == 1 ? sample->GetBufferByIndex(0, &buffer) : sample->ConvertToContiguousBuffer(&buffer);
    if (FAILED(hr) || !buffer) {
      return;
    }
    const LockedPixels pixels(buffer.Get(), defaultStride_);
    if (pixels.data() == nullptr || pixels.pitch() <= 0) {
      noteUnusableBuffer("lock_failed");
      return;
    }
    const uint32_t pitch = static_cast<uint32_t>(pixels.pitch());
    const uint32_t chromaRows = nv12ChromaRows(height_);
    // Bytes the planes below reach; the last row only needs its visible part.
    const size_t rows = nv12_ ? static_cast<size_t>(height_) + chromaRows : height_;
    const size_t lastRow = nv12_ ? static_cast<size_t>(2) * nv12ChromaWidth(width_) : static_cast<size_t>(width_) * 2;
    const size_t required = static_cast<size_t>(pitch) * (rows - 1) + lastRow;
    if (pitch < (nv12_ ? width_ : width_ * 2) || (pixels.available() != 0 && pixels.available() < required)) {
      noteUnusableBuffer("buffer_too_small");
      return;
    }

    CapturedFrame frame;
    frame.width = width_;
    frame.height = height_;
    frame.pixelFormat = pixelFormat_;
    frame.captureNs = captureTimeNs(sample);
    frame.planes[0] = FramePlane{pixels.data(), pitch, height_};
    frame.planeCount = 1;
    if (nv12_) {
      // The interleaved chroma plane follows the luma rows at the same pitch.
      frame.planes[1] = FramePlane{pixels.data() + static_cast<size_t>(pitch) * height_, pitch, chromaRows};
      frame.planeCount = 2;
    }
    FrameSink sink;
    {
      std::lock_guard<std::mutex> lock(sinkMutex_);
      sink = sink_;
    }
    if (sink) {
      sink(frame);
    }
  }

  // Once per session: a buffer we cannot read is a driver trait, not a per-frame event.
  void noteUnusableBuffer(const char *reason) {
    if (bufferComplaint_.exchange(true)) {
      return;
    }
    emitHelperEvent("{\"type\":\"pgm_capture_error\",\"code\":\"unsupported_format\",\"hr\":null,\"reason\":\"" + std::string(reason) + "\"}");
  }

  void notifyCaptureError(HRESULT hr, const std::string &reason) {
    if (shutdownStarted_.load()) {
      return;
    }
    emitHelperEvent("{\"type\":\"pgm_capture_error\",\"code\":\"" + std::string(uvcOpenErrorCode(static_cast<uint32_t>(hr))) +
                    "\",\"hr\":\"" + hresultHex(hr) + "\",\"reason\":\"" + jsonEscape(reason) + "\"}");
  }

  const std::string displayName_;
  std::atomic<long> refCount_{1};
  std::atomic<bool> running_{false};
  std::atomic<bool> shutdownStarted_{false};
  std::atomic<bool> decodesMjpg_{false};
  std::atomic<bool> bufferComplaint_{false};

  // Guards reader_ / source_, the flush handshake and the first-result handshake.
  std::mutex stateMutex_;
  std::condition_variable flushCv_;
  std::condition_variable firstCv_;
  ComPtr<IMFSourceReader> reader_;
  ComPtr<IMFMediaSource> source_;
  bool flushCompleted_ = false;
  bool abandoned_ = false;
  bool firstSeen_ = false;
  bool firstWaitOver_ = false;  // open() no longer waits for the first result
  HRESULT firstResult_ = S_OK;

  // Format fields: see refreshFormat.
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  bool nv12_ = false;
  std::string pixelFormat_;
  LONG defaultStride_ = 0;

  std::mutex sinkMutex_;
  FrameSink sink_;
};

class UvcVideoSource final : public VideoSource {
 public:
  UvcVideoSource(std::string symbolicLink, std::string displayName)
      : symbolicLink_(std::move(symbolicLink)), displayName_(std::move(displayName)) {}
  ~UvcVideoSource() override { stop(); }

  bool start(FrameSink sink, std::string &errorCode, std::string &error) override {
    const ComApartment apartment;
    std::lock_guard<std::mutex> lock(mutex_);
    if (session_) {
      return true;
    }
    std::wstring wideLink;
    if (!broadify::helper::tryUtf8ToWide(symbolicLink_, wideLink) || wideLink.empty()) {
      errorCode = "unsupported_format";
      error = "The video input id is not valid.";
      return false;
    }
    ComPtr<UvcSession> session;
    session.Attach(new UvcSession(displayName_));
    if (!session->open(wideLink, std::move(sink), errorCode, error)) {
      session->shutdown();
      return false;
    }
    session_ = std::move(session);
    return true;
  }

  void stop() override {
    const ComApartment apartment;
    ComPtr<UvcSession> session;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session.Swap(session_);
    }
    if (session) {
      session->shutdown();
    }
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return session_ && session_->running();
  }

  std::string decode() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return session_ && session_->decodesMjpg() ? "mjpg" : "";
  }

 private:
  const std::string symbolicLink_;
  const std::string displayName_;
  ComPtr<UvcSession> session_;
  mutable std::mutex mutex_;
};

// Device arrival and removal through the configuration manager: no window, no
// message loop. The notification callback only marks the change; a worker
// thread waits for the burst to end and then calls the handler, so the
// handler may enumerate and take its own locks.
class DeviceChangeWatcher {
 public:
  DeviceChangeWatcher() {
    worker_ = std::thread([this]() { run(); });
    for (const GUID &category : {kCategoryVideoCamera, kCategoryVideo}) {
      CM_NOTIFY_FILTER filter{};
      filter.cbSize = sizeof(filter);
      filter.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
      filter.u.DeviceInterface.ClassGuid = category;
      HCMNOTIFICATION handle = nullptr;
      if (CM_Register_Notification(&filter, this, &DeviceChangeWatcher::onNotification, &handle) == CR_SUCCESS && handle != nullptr) {
        registrations_.push_back(handle);
      }
    }
    if (registrations_.empty()) {
      emitHelperEvent("{\"type\":\"pgm_hotplug_unavailable\"}");
    }
  }

  ~DeviceChangeWatcher() {
    // Waits for running notification callbacks; must not run inside one.
    for (HCMNOTIFICATION handle : registrations_) {
      CM_Unregister_Notification(handle);
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable()) {
      worker_.join();
    }
  }

  DeviceChangeWatcher(const DeviceChangeWatcher &) = delete;
  DeviceChangeWatcher &operator=(const DeviceChangeWatcher &) = delete;

  void setHandler(std::function<void()> handler) {
    std::lock_guard<std::mutex> lock(mutex_);
    handler_ = std::move(handler);
  }

 private:
  static DWORD CALLBACK onNotification(HCMNOTIFICATION, PVOID context, CM_NOTIFY_ACTION action, PCM_NOTIFY_EVENT_DATA, DWORD) {
    if (action == CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL || action == CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL) {
      DeviceChangeWatcher *self = static_cast<DeviceChangeWatcher *>(context);
      {
        std::lock_guard<std::mutex> lock(self->mutex_);
        self->changed_ = true;
      }
      self->cv_.notify_all();
    }
    return ERROR_SUCCESS;
  }

  void run() {
    std::unique_lock<std::mutex> lock(mutex_);
    while (!stopping_) {
      cv_.wait(lock, [this] { return stopping_ || changed_; });
      // Debounce: wait until no further notification arrived for the interval.
      while (!stopping_) {
        changed_ = false;
        if (!cv_.wait_for(lock, kHotPlugDebounce, [this] { return stopping_ || changed_; })) {
          break;
        }
      }
      if (stopping_) {
        break;
      }
      const std::function<void()> handler = handler_;
      lock.unlock();
      if (handler) {
        handler();
      }
      lock.lock();
    }
  }

  std::vector<HCMNOTIFICATION> registrations_;
  std::thread worker_;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::function<void()> handler_;
  bool changed_ = false;
  bool stopping_ = false;
};

// "Deny" in the capability consent store turns the camera off for desktop
// applications (Settings > Privacy & security > Camera). Windows shows no
// prompt for them, so there is nothing to ask for: the value is only read.
std::string consentValue(HKEY root, const wchar_t *subKey) {
  wchar_t value[32] = {};
  DWORD size = sizeof(value) - sizeof(wchar_t);
  if (RegGetValueW(root, subKey, L"Value", RRF_RT_REG_SZ, nullptr, value, &size) != ERROR_SUCCESS) {
    return "";
  }
  return wideToUtf8(value);
}

class UvcEnumerator final : public VideoInputEnumerator {
 public:
  std::vector<VideoInputInfo> list() override {
    const ComApartment apartment;
    HRESULT hr = S_OK;
    const std::vector<DeviceEntry> devices = enumerateDevices(hr);
    if (FAILED(hr) && !enumerationFailureReported_.exchange(true)) {
      emitHelperEvent("{\"type\":\"pgm_uvc_enumeration_failed\",\"hr\":\"" + hresultHex(hr) + "\"}");
    }
    std::vector<VideoInputInfo> inputs;
    for (const DeviceEntry &device : devices) {
      if (isBroadifyVirtualCamera(device.name, device.symbolicLink)) {
        continue;  // never capture our own virtual camera
      }
      VideoInputInfo info;
      info.kind = "uvc";
      info.displayName = device.name;
      info.deviceId = device.symbolicLink;
      // Device interface paths are case-insensitive and not always spelled the same way.
      info.stableKey = lowerAscii(device.symbolicLink);
      info.id = "uvc:" + info.stableKey;
      info.available = true;
      // Not known before opening; a device another application holds fails to start with device_in_use.
      info.inUse = false;
      inputs.push_back(std::move(info));
    }
    return inputs;
  }

  void setChangeHandler(std::function<void()> handler) override { watcher_.setHandler(std::move(handler)); }

  std::string ensureCameraAuthorization() override {
    static const wchar_t *const WEBCAM = L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam";
    static const wchar_t *const WEBCAM_DESKTOP_APPS =
        L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\\NonPackaged";
    if (consentValue(HKEY_LOCAL_MACHINE, WEBCAM) == "Deny") {
      return "restricted";  // off for the whole device
    }
    if (consentValue(HKEY_CURRENT_USER, WEBCAM) == "Deny" || consentValue(HKEY_CURRENT_USER, WEBCAM_DESKTOP_APPS) == "Deny") {
      return "denied";
    }
    return "authorized";
  }

  std::unique_ptr<VideoSource> open(const std::string &stableKey) override {
    const ComApartment apartment;
    HRESULT hr = S_OK;
    const std::string wanted = lowerAscii(stableKey);
    for (const DeviceEntry &device : enumerateDevices(hr)) {
      if (lowerAscii(device.symbolicLink) == wanted && !isBroadifyVirtualCamera(device.name, device.symbolicLink)) {
        return std::make_unique<UvcVideoSource>(device.symbolicLink, device.name);
      }
    }
    return nullptr;
  }

 private:
  std::atomic<bool> enumerationFailureReported_{false};
  // Last member: its destructor stops the notifications before anything else goes away.
  DeviceChangeWatcher watcher_;
};

}  // namespace

std::unique_ptr<VideoInputEnumerator> createUvcEnumerator() { return std::make_unique<UvcEnumerator>(); }

}  // namespace broadify::pgm

#endif  // _WIN32
