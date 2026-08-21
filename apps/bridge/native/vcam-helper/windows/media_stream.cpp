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
constexpr uint64_t kStaleLogWindowMs = 2000;
constexpr uint64_t kVeryStaleLogWindowMs = 10000;
constexpr size_t kSampleBufferPoolSize = 3;

// True when the payload is a dense BGRA8 image of the claimed size.
bool isWellFormed(const RawFrame &frame) {
  if (frame.width == 0 || frame.height == 0) {
    return false;
  }
  const uint64_t expected =
      static_cast<uint64_t>(frame.width) * frame.height * 4ull;
  return frame.bgra.size() == expected;
}

// Nearest-neighbour stretch of a dense BGRA8 source into a dense BGRA8
// destination of a different size. No letterboxing: the virtual camera keeps
// showing the program picture rather than a splash when the helper's
// geometry differs from the negotiated media type. Row/column lookups use
// 64-bit arithmetic so width*height products cannot overflow.
void scaleNearest(const uint8_t *src, uint32_t srcWidth, uint32_t srcHeight,
                  uint8_t *dst, uint32_t dstWidth, uint32_t dstHeight) {
  const size_t srcStride = static_cast<size_t>(srcWidth) * 4u;
  const size_t dstStride = static_cast<size_t>(dstWidth) * 4u;
  for (uint32_t y = 0; y < dstHeight; y++) {
    const uint32_t sy = static_cast<uint32_t>(
        (static_cast<uint64_t>(y) * srcHeight) / dstHeight);
    const uint8_t *srcRow = src + static_cast<size_t>(sy) * srcStride;
    uint8_t *dstRow = dst + static_cast<size_t>(y) * dstStride;
    if (srcWidth == dstWidth) {
      std::memcpy(dstRow, srcRow, dstStride);
      continue;
    }
    for (uint32_t x = 0; x < dstWidth; x++) {
      const uint32_t sx = static_cast<uint32_t>(
          (static_cast<uint64_t>(x) * srcWidth) / dstWidth);
      std::memcpy(dstRow + static_cast<size_t>(x) * 4u,
                  srcRow + static_cast<size_t>(sx) * 4u, 4u);
    }
  }
}

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

  const DWORD frameBytes = _width * _height * 4;
  _sampleBuffers.clear();
  _sampleBuffers.reserve(kSampleBufferPoolSize);
  for (size_t i = 0; i < kSampleBufferPoolSize; i++) {
    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    CK(MFCreateMemoryBuffer(frameBytes, &buffer));
    _sampleBuffers.push_back(buffer);
  }
  return S_OK;
}

HRESULT MediaStream::Start() {
  try {
    RawFrameClient *client = nullptr;
    {
      winrt::slim_lock_guard lock(_lock);
      if (!_queue) return MF_E_SHUTDOWN;
      CK(_queue->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr));
      _state = MF_STREAM_STATE_RUNNING;
      client = _client;
    }
    // Consume the raw-frame stream only while an app is actually pulling
    // samples; the connection is what makes the helper render and send frames.
    if (client) {
      client->start();
      VcamLog("MediaStream: running, raw-frame client connecting");
    }
    return S_OK;
  } catch (...) {
    VcamLog("MediaStream::Start exception");
    return E_FAIL;
  }
}

HRESULT MediaStream::Stop() {
  try {
    RawFrameClient *client = nullptr;
    {
      winrt::slim_lock_guard lock(_lock);
      if (!_queue) return MF_E_SHUTDOWN;
      CK(_queue->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr));
      _state = MF_STREAM_STATE_STOPPED;
      client = _client;
    }
    if (client) {
      client->stop();
      VcamLog("MediaStream: stopped, raw-frame client disconnected");
    }
    return S_OK;
  } catch (...) {
    VcamLog("MediaStream::Stop exception");
    return E_FAIL;
  }
}

void MediaStream::Shutdown() {
  try {
    RawFrameClient *client = nullptr;
    {
      winrt::slim_lock_guard lock(_lock);
      if (_queue) {
        _queue->Shutdown();
        _queue.Reset();
      }
      client = _client;
      _client = nullptr;
      _descriptor.Reset();
      _sampleBuffers.clear();
      _lastSampleBuffer.Reset();
      _lastSequence = 0;
      _baseCaptureNs = 0;
      _baseSampleTime = 0;
      _lastSampleTime = 0;
      _source = nullptr;
    }
    if (client) {
      client->stop();
    }
  } catch (...) {
    VcamLog("MediaStream::Shutdown exception");
  }
}

STDMETHODIMP MediaStream::BeginGetEvent(IMFAsyncCallback *callback,
                                        IUnknown *state) {
  try {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    return _queue->BeginGetEvent(callback, state);
  } catch (...) {
    VcamLog("MediaStream::BeginGetEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::EndGetEvent(IMFAsyncResult *result,
                                      IMFMediaEvent **event) {
  try {
    if (!event) return E_POINTER;
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    return _queue->EndGetEvent(result, event);
  } catch (...) {
    VcamLog("MediaStream::EndGetEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::GetEvent(DWORD flags, IMFMediaEvent **event) {
  try {
    Microsoft::WRL::ComPtr<IMFMediaEventQueue> queue;
    {
      winrt::slim_lock_guard lock(_lock);
      if (!_queue) return MF_E_SHUTDOWN;
      queue = _queue;
    }
    return queue->GetEvent(flags, event);
  } catch (...) {
    VcamLog("MediaStream::GetEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::QueueEvent(MediaEventType type, REFGUID extended,
                                     HRESULT status, const PROPVARIANT *value) {
  try {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;
    return _queue->QueueEventParamVar(type, extended, status, value);
  } catch (...) {
    VcamLog("MediaStream::QueueEvent exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::GetMediaSource(IMFMediaSource **source) {
  try {
    if (!source) return E_POINTER;
    *source = nullptr;
    winrt::slim_lock_guard lock(_lock);
    if (!_source) return MF_E_SHUTDOWN;
    _source->AddRef();
    *source = _source;
    return S_OK;
  } catch (...) {
    VcamLog("MediaStream::GetMediaSource exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::GetStreamDescriptor(IMFStreamDescriptor **descriptor) {
  try {
    if (!descriptor) return E_POINTER;
    *descriptor = nullptr;
    winrt::slim_lock_guard lock(_lock);
    if (!_descriptor) return MF_E_SHUTDOWN;
    return _descriptor.CopyTo(descriptor);
  } catch (...) {
    VcamLog("MediaStream::GetStreamDescriptor exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::RequestSample(IUnknown *token) {
  try {
    winrt::slim_lock_guard lock(_lock);
    if (!_queue) return MF_E_SHUTDOWN;

    const DWORD frameBytes = _width * _height * 4;
    Microsoft::WRL::ComPtr<IMFSample> sample;
    CK(MFCreateSample(&sample));

    if (_client && _hasLastGoodFrame) {
      const uint64_t staleAgeMs = _client->staleAgeMs();
      const uint64_t staleWindow = staleAgeMs >= kVeryStaleLogWindowMs
                                       ? kVeryStaleLogWindowMs
                                       : staleAgeMs >= kStaleLogWindowMs
                                             ? kStaleLogWindowMs
                                             : 0;
      if (_loggedStaleWindowMs != staleWindow) {
        if (staleWindow != 0) {
          VcamLog("MediaStream: raw frame stream stale for %llu ms, re-emitting last frame",
                  static_cast<unsigned long long>(staleAgeMs));
        }
        _loggedStaleWindowMs = staleWindow;
      }
    }

    const bool hasNewFrame =
        _client && _client->copyLatestIfNew(_lastSequence, _scratchFrame);
    bool usePreviousSample = _hasLastGoodFrame;
    LONGLONG sampleTime =
        _hasLastGoodFrame ? _lastSampleTime + kFrameDuration : MFGetSystemTime();
    if (hasNewFrame && isWellFormed(_scratchFrame)) {
      Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer =
          _sampleBuffers[_nextSampleBuffer];
      _nextSampleBuffer = (_nextSampleBuffer + 1) % _sampleBuffers.size();
      BYTE *dst = nullptr;
      CK(buffer->Lock(&dst, nullptr, nullptr));
      if (_scratchFrame.width == _width && _scratchFrame.height == _height) {
        std::memcpy(dst, _scratchFrame.bgra.data(), frameBytes);
      } else {
        if (_scratchFrame.width != _loggedMismatchWidth ||
            _scratchFrame.height != _loggedMismatchHeight) {
          _loggedMismatchWidth = _scratchFrame.width;
          _loggedMismatchHeight = _scratchFrame.height;
          VcamLog(
              "MediaStream: source %ux%u differs from media type %ux%u, scaling",
              _scratchFrame.width, _scratchFrame.height, _width, _height);
        }
        scaleNearest(_scratchFrame.bgra.data(), _scratchFrame.width,
                     _scratchFrame.height, dst, _width, _height);
      }
      buffer->Unlock();
      buffer->SetCurrentLength(frameBytes);
      _lastSampleBuffer = buffer;
      _lastSequence = _scratchFrame.sequence;
      _hasLastGoodFrame = true;
      usePreviousSample = true;
      if (_scratchFrame.captureNs > 0) {
        if (_baseCaptureNs == 0 || _scratchFrame.captureNs < _baseCaptureNs) {
          _baseCaptureNs = _scratchFrame.captureNs;
          _baseSampleTime = MFGetSystemTime();
        }
        sampleTime =
            _baseSampleTime +
            static_cast<LONGLONG>((_scratchFrame.captureNs - _baseCaptureNs) /
                                  100u);
      }
    } else if (hasNewFrame) {
      VcamLog("MediaStream: malformed frame %ux%u size=%llu, re-emitting last frame",
              _scratchFrame.width, _scratchFrame.height,
              static_cast<unsigned long long>(_scratchFrame.bgra.size()));
    }

    if (usePreviousSample && _lastSampleBuffer) {
      CK(sample->AddBuffer(_lastSampleBuffer.Get()));
    } else {
      Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer =
          _sampleBuffers[_nextSampleBuffer];
      _nextSampleBuffer = (_nextSampleBuffer + 1) % _sampleBuffers.size();
      BYTE *dst = nullptr;
      CK(buffer->Lock(&dst, nullptr, nullptr));
      std::memset(dst, 0x1e, frameBytes);
      buffer->Unlock();
      buffer->SetCurrentLength(frameBytes);
      CK(sample->AddBuffer(buffer.Get()));
    }

    if (_hasLastGoodFrame && sampleTime <= _lastSampleTime) {
      sampleTime = _lastSampleTime + 1;
    }
    _lastSampleTime = sampleTime;
    CK(sample->SetSampleTime(sampleTime));
    CK(sample->SetSampleDuration(kFrameDuration));
    if (token) {
      CK(sample->SetUnknown(MFSampleExtension_Token, token));
    }
    CK(_queue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get()));
    return S_OK;
  } catch (...) {
    VcamLog("MediaStream::RequestSample exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::SetStreamState(MF_STREAM_STATE state) {
  try {
    if (_state == state) return S_OK;
    switch (state) {
      case MF_STREAM_STATE_RUNNING:
        return Start();
      case MF_STREAM_STATE_STOPPED:
        return Stop();
      default:
        return MF_E_INVALID_STATE_TRANSITION;
    }
  } catch (...) {
    VcamLog("MediaStream::SetStreamState exception");
    return E_FAIL;
  }
}

STDMETHODIMP MediaStream::GetStreamState(MF_STREAM_STATE *state) {
  try {
    if (!state) return E_POINTER;
    *state = _state;
    return S_OK;
  } catch (...) {
    VcamLog("MediaStream::GetStreamState exception");
    return E_FAIL;
  }
}

STDMETHODIMP
MediaStream::KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  try {
    if (bytesReturned) *bytesReturned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  } catch (...) {
    VcamLog("MediaStream::KsProperty exception");
    return E_FAIL;
  }
}

STDMETHODIMP
MediaStream::KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  try {
    if (bytesReturned) *bytesReturned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  } catch (...) {
    VcamLog("MediaStream::KsMethod exception");
    return E_FAIL;
  }
}

STDMETHODIMP
MediaStream::KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG *bytesReturned) {
  try {
    if (bytesReturned) *bytesReturned = 0;
    return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
  } catch (...) {
    VcamLog("MediaStream::KsEvent exception");
    return E_FAIL;
  }
}

}  // namespace broadify::vcam
