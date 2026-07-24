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
constexpr uint32_t kFallbackWidth = 1280;
constexpr uint32_t kFallbackHeight = 720;

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

HRESULT MediaSource::Initialize(IMFAttributes *attributes) {
  if (attributes) {
    attributes->CopyAllItems(this);
  }

  // Connect to the raw-frame stream and briefly wait for the first frame so the
  // advertised media type matches the real program geometry.
  _client = std::make_unique<RawFrameClient>(resolvePort());
  _client->start();
  _width = kFallbackWidth;
  _height = kFallbackHeight;
  RawFrame frame;
  for (int i = 0; i < 20; i++) {
    Sleep(100);
    if (_client->copyLatest(frame) && frame.width > 0 && frame.height > 0) {
      _width = frame.width;
      _height = frame.height;
      break;
    }
  }
  VcamLog("MediaSource::Initialize geometry %ux%u", _width, _height);

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
  return S_OK;
}

STDMETHODIMP MediaSource::BeginGetEvent(IMFAsyncCallback *callback,
                                        IUnknown *state) {
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  return _queue->BeginGetEvent(callback, state);
}

STDMETHODIMP MediaSource::EndGetEvent(IMFAsyncResult *result,
                                      IMFMediaEvent **event) {
  if (!event) return E_POINTER;
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  return _queue->EndGetEvent(result, event);
}

STDMETHODIMP MediaSource::GetEvent(DWORD flags, IMFMediaEvent **event) {
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> queue;
  {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    queue = _queue;
  }
  return queue->GetEvent(flags, event);
}

STDMETHODIMP MediaSource::QueueEvent(MediaEventType type, REFGUID extended,
                                     HRESULT status, const PROPVARIANT *value) {
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  return _queue->QueueEventParamVar(type, extended, status, value);
}

STDMETHODIMP MediaSource::CreatePresentationDescriptor(
    IMFPresentationDescriptor **descriptor) {
  if (!descriptor) return E_POINTER;
  *descriptor = nullptr;
  winrt::slim_lock_guard lock(_lock);
  if (!_descriptor) return MF_E_SHUTDOWN;
  return _descriptor->Clone(descriptor);
}

STDMETHODIMP MediaSource::GetCharacteristics(DWORD *characteristics) {
  if (!characteristics) return E_POINTER;
  *characteristics = MFMEDIASOURCE_IS_LIVE;
  return S_OK;
}

STDMETHODIMP MediaSource::Pause() { return MF_E_INVALID_STATE_TRANSITION; }

STDMETHODIMP MediaSource::Shutdown() {
  winrt::slim_lock_guard lock(_lock);
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
  return S_OK;
}

STDMETHODIMP MediaSource::Start(IMFPresentationDescriptor *descriptor,
                                const GUID *timeFormat,
                                const PROPVARIANT *startPosition) {
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
}

STDMETHODIMP MediaSource::Stop() {
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
}

STDMETHODIMP MediaSource::GetSourceAttributes(IMFAttributes **attributes) {
  if (!attributes) return E_POINTER;
  winrt::slim_lock_guard lock(_lock);
  return QueryInterface(IID_PPV_ARGS(attributes));
}

STDMETHODIMP MediaSource::GetStreamAttributes(DWORD streamId,
                                              IMFAttributes **attributes) {
  if (!attributes) return E_POINTER;
  *attributes = nullptr;
  winrt::slim_lock_guard lock(_lock);
  if (streamId != 0 || !_stream) return E_INVALIDARG;
  _stream.as<IMFAttributes>().copy_to(attributes);
  return S_OK;
}

STDMETHODIMP MediaSource::SetD3DManager(IUnknown *) {
  // CPU path only: the stream self-allocates system-memory samples.
  return S_OK;
}

STDMETHODIMP MediaSource::GetService(REFGUID, REFIID, LPVOID *object) {
  if (object) *object = nullptr;
  return MF_E_UNSUPPORTED_SERVICE;
}

STDMETHODIMP
MediaSource::KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG,
                        ULONG *bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

STDMETHODIMP
MediaSource::KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

STDMETHODIMP
MediaSource::KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

}  // namespace broadify::vcam
