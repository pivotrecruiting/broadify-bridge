#include "media_source.h"

#include "vcam_log.h"

#include <mferror.h>
#include <windows.h>

#include <cstdlib>

namespace broadify::vcam {
namespace {

#define CK(x)                        \
  do {                               \
    const HRESULT _hr = (x);         \
    if (FAILED(_hr)) return _hr;     \
  } while (0)

constexpr uint16_t kDefaultPort = 18787;
// Matches the meeting helper's default program size (Options::width/height
// in meeting-helper/src/common/options.h). Used only when neither the
// handshake nor a frame answered within the probe window.
constexpr uint32_t kFallbackWidth = 1920;
constexpr uint32_t kFallbackHeight = 1080;
constexpr int kProbeSteps = 20;       // x kProbeStepMs = ~2 s probe window.
constexpr DWORD kProbeStepMs = 100;

uint16_t resolvePort() {
  char value[16] = {0};
  if (GetEnvironmentVariableA("MEETING_VCAM_FRAME_PORT", value, sizeof(value)) >
      0) {
    const int parsed = atoi(value);
    if (parsed > 0 && parsed <= 65535) {
      return static_cast<uint16_t>(parsed);
    }
  }
  return kDefaultPort;
}

}  // namespace

MediaSource::~MediaSource() { Shutdown(); }

HRESULT MediaSource::Initialize(IMFAttributes *attributes) {
  if (attributes) {
    attributes->CopyAllItems(this);
  }

  // One-off geometry probe: connect to the raw-frame stream and wait briefly
  // for either the handshake geometry (X-Broadify-Frame-* headers, available
  // immediately) or the first frame, so the advertised media type matches the
  // real program geometry; then disconnect again. The Frame Server
  // instantiates this source as soon as the camera is armed — long before any
  // app streams — and an open connection makes the helper render, swizzle and
  // send every frame. MediaStream reconnects for as long as the stream is
  // actually running. The handshake is preferred because the probe runs while
  // the helper is busiest (engine start), when the first frame can take
  // longer than the probe window; missing it used to leave the media type at
  // a wrong size and the stream permanently on the splash.
  _client = std::make_unique<RawFrameClient>(resolvePort());
  _client->start();
  _width = kFallbackWidth;
  _height = kFallbackHeight;
  const char *geometrySource = "fallback";
  RawFrame frame;
  for (int i = 0; i < kProbeSteps; i++) {
    Sleep(kProbeStepMs);
    uint32_t streamWidth = 0;
    uint32_t streamHeight = 0;
    if (_client->streamGeometry(streamWidth, streamHeight)) {
      _width = streamWidth;
      _height = streamHeight;
      geometrySource = "handshake";
      break;
    }
    if (_client->copyLatest(frame) && frame.width > 0 && frame.height > 0) {
      _width = frame.width;
      _height = frame.height;
      geometrySource = "frame";
      break;
    }
  }
  _client->stop();
  VcamLog("MediaSource::Initialize geometry %ux%u from %s (probe disconnected)",
          _width, _height, geometrySource);

  _stream = winrt::make_self<MediaStream>();
  CK(_stream->Initialize(this, 0, _client.get(), _width, _height));

  Microsoft::WRL::ComPtr<IMFStreamDescriptor> descriptor;
  CK(_stream->GetStreamDescriptor(&descriptor));
  IMFStreamDescriptor *descriptors[] = {descriptor.Get()};
  CK(MFCreatePresentationDescriptor(1, descriptors, &_descriptor));

  // The single stream is selected by default.
  BOOL selected = FALSE;
  Microsoft::WRL::ComPtr<IMFStreamDescriptor> ignored;
  _descriptor->GetStreamDescriptorByIndex(0, &selected, &ignored);
  if (!selected) {
    _descriptor->SelectStream(0);
  }

  CK(MFCreateEventQueue(&_queue));
  _shutdown = false;
  return S_OK;
}

bool MediaSource::IsShutdown() {
  winrt::slim_lock_guard lock(_lock);
  return _shutdown;
}

STDMETHODIMP MediaSource::BeginGetEvent(IMFAsyncCallback *callback,
                                        IUnknown *state) {
  try {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    return _queue->BeginGetEvent(callback, state);
  } catch (...) {
    VcamLog("MediaSource::BeginGetEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::EndGetEvent(IMFAsyncResult *result,
                                      IMFMediaEvent **event) {
  try {
    if (!event) return E_POINTER;
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    return _queue->EndGetEvent(result, event);
  } catch (...) {
    VcamLog("MediaSource::EndGetEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::GetEvent(DWORD flags, IMFMediaEvent **event) {
  try {
    Microsoft::WRL::ComPtr<IMFMediaEventQueue> queue;
    {
      winrt::slim_lock_guard lock(_lock);
      if (!_queue) return MF_E_SHUTDOWN;
      queue = _queue;
    }
    return queue->GetEvent(flags, event);
  } catch (...) {
    VcamLog("MediaSource::GetEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::QueueEvent(MediaEventType type, REFGUID extended,
                                     HRESULT status, const PROPVARIANT *value) {
  try {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    return _queue->QueueEventParamVar(type, extended, status, value);
  } catch (...) {
    VcamLog("MediaSource::QueueEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::CreatePresentationDescriptor(
    IMFPresentationDescriptor **descriptor) {
  try {
    if (!descriptor) return E_POINTER;
    *descriptor = nullptr;
    winrt::slim_lock_guard lock(_lock);
    if (!_descriptor) return MF_E_SHUTDOWN;
    return _descriptor->Clone(descriptor);
  } catch (...) {
    VcamLog("MediaSource::CreatePresentationDescriptor exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::GetCharacteristics(DWORD *characteristics) {
  try {
    if (!characteristics) return E_POINTER;
    *characteristics = MFMEDIASOURCE_IS_LIVE;
    return S_OK;
  } catch (...) {
    VcamLog("MediaSource::GetCharacteristics exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::Pause() {
  try {
    return MF_E_INVALID_STATE_TRANSITION;
  } catch (...) {
    VcamLog("MediaSource::Pause exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::Shutdown() {
  try {
    winrt::slim_lock_guard lock(_lock);
    if (_shutdown) return S_OK;
    _shutdown = true;
    if (_queue) {
      _queue->Shutdown();
      _queue.Reset();
    }
    if (_stream) {
      _stream->Shutdown();
    }
    _descriptor.Reset();
    if (_client) {
      _client->stop();
    }
    _stream = nullptr;
    _client.reset();
    return S_OK;
  } catch (...) {
    VcamLog("MediaSource::Shutdown exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::Start(IMFPresentationDescriptor *descriptor,
                                const GUID *timeFormat,
                                const PROPVARIANT *startPosition) {
  try {
    if (!descriptor || !startPosition) return E_POINTER;
    if (timeFormat && *timeFormat != GUID_NULL) return E_INVALIDARG;
    winrt::slim_lock_guard lock(_lock);
    if (!_queue || !_descriptor) return MF_E_SHUTDOWN;

    PROPVARIANT time;
    PropVariantInit(&time);
    time.vt = VT_I8;
    time.hVal.QuadPart = MFGetSystemTime();

    _descriptor->SelectStream(0);

    winrt::com_ptr<IUnknown> streamUnknown = _stream.as<IUnknown>();
    CK(_queue->QueueEventParamUnk(MENewStream, GUID_NULL, S_OK,
                                  streamUnknown.get()));
    CK(_stream->Start());
    CK(_queue->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &time));
    PropVariantClear(&time);
    return S_OK;
  } catch (...) {
    VcamLog("MediaSource::Start exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::Stop() {
  try {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue || !_descriptor) return MF_E_SHUTDOWN;

    PROPVARIANT time;
    PropVariantInit(&time);
    time.vt = VT_I8;
    time.hVal.QuadPart = MFGetSystemTime();

    CK(_stream->Stop());
    _descriptor->DeselectStream(0);
    CK(_queue->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, &time));
    PropVariantClear(&time);
    return S_OK;
  } catch (...) {
    VcamLog("MediaSource::Stop exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::GetSourceAttributes(IMFAttributes **attributes) {
  try {
    if (!attributes) return E_POINTER;
    winrt::slim_lock_guard lock(_lock);
    return QueryInterface(IID_PPV_ARGS(attributes));
  } catch (...) {
    VcamLog("MediaSource::GetSourceAttributes exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::GetStreamAttributes(DWORD streamId,
                                              IMFAttributes **attributes) {
  try {
    if (!attributes) return E_POINTER;
    *attributes = nullptr;
    winrt::slim_lock_guard lock(_lock);
    if (streamId != 0 || !_stream) return E_INVALIDARG;
    _stream.as<IMFAttributes>().copy_to(attributes);
    return S_OK;
  } catch (...) {
    VcamLog("MediaSource::GetStreamAttributes exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::SetD3DManager(IUnknown *) {
  try {
    // CPU path only: the stream self-allocates system-memory samples.
    return S_OK;
  } catch (...) {
    VcamLog("MediaSource::SetD3DManager exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaSource::GetService(REFGUID, REFIID, LPVOID *object) {
  try {
    if (object) *object = nullptr;
    return MF_E_UNSUPPORTED_SERVICE;
  } catch (...) {
    VcamLog("MediaSource::GetService exception");
    return E_FAIL;
  }
}

STDMETHODIMP
MediaSource::KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG,
                        ULONG *bytesReturned) {
  try {
    if (bytesReturned) *bytesReturned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  } catch (...) {
    VcamLog("MediaSource::KsProperty exception");
    return E_FAIL;
  }
}

STDMETHODIMP
MediaSource::KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  try {
    if (bytesReturned) *bytesReturned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  } catch (...) {
    VcamLog("MediaSource::KsMethod exception");
    return E_FAIL;
  }
}

STDMETHODIMP
MediaSource::KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  try {
    if (bytesReturned) *bytesReturned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  } catch (...) {
    VcamLog("MediaSource::KsEvent exception");
    return E_FAIL;
  }
}

}  // namespace broadify::vcam
