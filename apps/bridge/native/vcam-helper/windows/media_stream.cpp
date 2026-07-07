#include "media_stream.h"

#include "vcam_log.h"

#include <ksmedia.h>
#include <mferror.h>

#include <cstring>

namespace broadify::vcam {
namespace {

#define CK(x)                        \
  do {                               \
    const HRESULT _hr = (x);         \
    if (FAILED(_hr)) return _hr;     \
  } while (0)

constexpr uint32_t kFrameRate = 30;
constexpr LONGLONG kFrameDuration = 10000000LL / kFrameRate;  // 100ns units.

}  // namespace

HRESULT MediaStream::Initialize(IMFMediaSource *source, int index,
                                RawFrameClient *client, uint32_t width,
                                uint32_t height) {
  if (!source || !client || width == 0 || height == 0) {
    return E_INVALIDARG;
  }
  _source = source;
  _index = index;
  _client = client;
  _width = width;
  _height = height;

  CK(SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE));
  CK(SetUINT32(MF_DEVICESTREAM_STREAM_ID, index));
  CK(SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1));
  CK(SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
               MFFrameSourceTypes_Color));

  CK(MFCreateEventQueue(&_queue));

  Microsoft::WRL::ComPtr<IMFMediaType> type;
  CK(MFCreateMediaType(&type));
  type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
  type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, _width, _height);
  type->SetUINT32(MF_MT_DEFAULT_STRIDE, _width * 4);  // positive = top-down.
  MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kFrameRate, 1);
  MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  type->SetUINT32(MF_MT_AVG_BITRATE, _width * _height * 4 * 8 * kFrameRate);

  IMFMediaType *types[] = {type.Get()};
  CK(MFCreateStreamDescriptor(_index, 1, types, &_descriptor));

  Microsoft::WRL::ComPtr<IMFMediaTypeHandler> handler;
  CK(_descriptor->GetMediaTypeHandler(&handler));
  CK(handler->SetCurrentMediaType(type.Get()));
  return S_OK;
}

HRESULT MediaStream::Start() {
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  CK(_queue->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr));
  _state = MF_STREAM_STATE_RUNNING;
  return S_OK;
}

HRESULT MediaStream::Stop() {
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  CK(_queue->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr));
  _state = MF_STREAM_STATE_STOPPED;
  return S_OK;
}

void MediaStream::Shutdown() {
  winrt::slim_lock_guard lock(_lock);
  if (_queue) {
    _queue->Shutdown();
    _queue.Reset();
  }
  _descriptor.Reset();
  _source.Reset();
}

STDMETHODIMP MediaStream::BeginGetEvent(IMFAsyncCallback *callback,
                                        IUnknown *state) {
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  return _queue->BeginGetEvent(callback, state);
}

STDMETHODIMP MediaStream::EndGetEvent(IMFAsyncResult *result,
                                      IMFMediaEvent **event) {
  if (!event) return E_POINTER;
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  return _queue->EndGetEvent(result, event);
}

STDMETHODIMP MediaStream::GetEvent(DWORD flags, IMFMediaEvent **event) {
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> queue;
  {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    queue = _queue;
  }
  return queue->GetEvent(flags, event);
}

STDMETHODIMP MediaStream::QueueEvent(MediaEventType type, REFGUID extended,
                                     HRESULT status, const PROPVARIANT *value) {
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;
  return _queue->QueueEventParamVar(type, extended, status, value);
}

STDMETHODIMP MediaStream::GetMediaSource(IMFMediaSource **source) {
  if (!source) return E_POINTER;
  *source = nullptr;
  winrt::slim_lock_guard lock(_lock);
  if (!_source) return MF_E_SHUTDOWN;
  return _source.CopyTo(source);
}

STDMETHODIMP MediaStream::GetStreamDescriptor(IMFStreamDescriptor **descriptor) {
  if (!descriptor) return E_POINTER;
  *descriptor = nullptr;
  winrt::slim_lock_guard lock(_lock);
  if (!_descriptor) return MF_E_SHUTDOWN;
  return _descriptor.CopyTo(descriptor);
}

STDMETHODIMP MediaStream::RequestSample(IUnknown *token) {
  winrt::slim_lock_guard lock(_lock);
  if (!_queue) return MF_E_SHUTDOWN;

  const DWORD frameBytes = _width * _height * 4;
  Microsoft::WRL::ComPtr<IMFSample> sample;
  CK(MFCreateSample(&sample));
  Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
  CK(MFCreateMemoryBuffer(frameBytes, &buffer));

  BYTE *dst = nullptr;
  CK(buffer->Lock(&dst, nullptr, nullptr));
  RawFrame frame;
  const bool live = _client->copyLatest(frame) && frame.width == _width &&
                    frame.height == _height && frame.bgra.size() == frameBytes &&
                    !_client->isStale();
  if (live) {
    std::memcpy(dst, frame.bgra.data(), frameBytes);  // BGRA == RGB32 layout.
    _lastSequence = frame.sequence;
  } else {
    std::memset(dst, 0x1e, frameBytes);  // dark splash until frames flow.
  }
  buffer->Unlock();
  buffer->SetCurrentLength(frameBytes);
  CK(sample->AddBuffer(buffer.Get()));

  CK(sample->SetSampleTime(MFGetSystemTime()));
  CK(sample->SetSampleDuration(kFrameDuration));
  if (token) {
    CK(sample->SetUnknown(MFSampleExtension_Token, token));
  }
  CK(_queue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get()));
  return S_OK;
}

STDMETHODIMP MediaStream::SetStreamState(MF_STREAM_STATE state) {
  if (_state == state) return S_OK;
  switch (state) {
    case MF_STREAM_STATE_RUNNING:
      return Start();
    case MF_STREAM_STATE_STOPPED:
      return Stop();
    default:
      return MF_E_INVALID_STATE_TRANSITION;
  }
}

STDMETHODIMP MediaStream::GetStreamState(MF_STREAM_STATE *state) {
  if (!state) return E_POINTER;
  *state = _state;
  return S_OK;
}

STDMETHODIMP
MediaStream::KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

STDMETHODIMP
MediaStream::KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

STDMETHODIMP
MediaStream::KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

}  // namespace broadify::vcam
