#include "media_stream.h"

#include "preview/vcam_shm_layout.h"
#include "vcam_log.h"

#include <ksmedia.h>
#include <mferror.h>

#include <algorithm>
#include <cstring>
#include <vector>
#include <windows.h>

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

DWORD sampleBytesForSubtype(const GUID &subtype,
                            uint32_t width,
                            uint32_t height) {
  if (subtype == MFVideoFormat_NV12) {
    return width * height * 3 / 2;
  }
  if (subtype == MFVideoFormat_YUY2) {
    return width * height * 2;
  }
  return width * height * 4;
}

HRESULT createSampleBufferPool(
    const GUID &subtype,
    uint32_t width,
    uint32_t height,
    std::vector<Microsoft::WRL::ComPtr<IMFMediaBuffer>> &buffers) {
  buffers.clear();
  buffers.reserve(kSampleBufferPoolSize);
  for (size_t i = 0; i < kSampleBufferPoolSize; i++) {
    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    if (subtype == MFVideoFormat_RGB32) {
      CK(MFCreateMemoryBuffer(sampleBytesForSubtype(subtype, width, height),
                              &buffer));
    } else {
      // MFCreate2DMediaBuffer takes the FourCC (DWORD), not the subtype GUID.
      CK(MFCreate2DMediaBuffer(width, height, subtype.Data1, FALSE, &buffer));
    }
    buffers.push_back(buffer);
  }
  return S_OK;
}

const char *subtypeName(const GUID &subtype) {
  if (subtype == MFVideoFormat_NV12) {
    return "NV12";
  }
  if (subtype == MFVideoFormat_YUY2) {
    return "YUY2";
  }
  if (subtype == MFVideoFormat_RGB32) {
    return "RGB32";
  }
  return "unknown";
}

const char *bufferKindForSubtype(const GUID &subtype) {
  return subtype == MFVideoFormat_RGB32 ? "memory" : "2d";
}

bool readOfferNv12Flag() {
  DWORD value = 0;
  DWORD valueBytes = sizeof(value);
  const LSTATUS status = RegGetValueW(
      HKEY_CURRENT_USER, L"Software\\Broadify\\VCam", L"OfferNv12",
      RRF_RT_REG_DWORD, nullptr, &value, &valueBytes);
  return status == ERROR_SUCCESS && value == 1u;
}

void logStreamType(const GUID &subtype) {
  VcamLog("stream_type subtype=%s buffer=%s", subtypeName(subtype),
          bufferKindForSubtype(subtype));
}

void fillSplash(const GUID &subtype, BYTE *dst, DWORD bytes, uint32_t width,
                uint32_t height) {
  if (subtype == MFVideoFormat_NV12) {
    const DWORD yBytes = width * height;
    std::memset(dst, 16, yBytes);
    std::memset(dst + yBytes, 128, bytes - yBytes);
    return;
  }
  if (subtype == MFVideoFormat_YUY2) {
    for (DWORD i = 0; i + 3 < bytes; i += 4) {
      dst[i] = 16;
      dst[i + 1] = 128;
      dst[i + 2] = 16;
      dst[i + 3] = 128;
    }
    return;
  }
  std::memset(dst, 0x1e, bytes);
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

void bgraToYuy2(const uint8_t *bgra,
                uint32_t width,
                uint32_t height,
                uint8_t *yuy2,
                size_t yuy2Size) {
  if (yuy2Size < static_cast<size_t>(width) * height * 2u) {
    return;
  }
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x + 1u < width; x += 2u) {
      const uint8_t *p0 = bgra + (static_cast<size_t>(y) * width + x) * 4u;
      const uint8_t *p1 = p0 + 4u;
      const int b0 = p0[0], g0 = p0[1], r0 = p0[2];
      const int b1 = p1[0], g1 = p1[1], r1 = p1[2];
      const uint8_t y0 = static_cast<uint8_t>(std::clamp(((66 * r0 + 129 * g0 + 25 * b0 + 128) >> 8) + 16, 0, 255));
      const uint8_t y1 = static_cast<uint8_t>(std::clamp(((66 * r1 + 129 * g1 + 25 * b1 + 128) >> 8) + 16, 0, 255));
      const int r = (r0 + r1) / 2;
      const int g = (g0 + g1) / 2;
      const int b = (b0 + b1) / 2;
      const uint8_t u = static_cast<uint8_t>(std::clamp(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128, 0, 255));
      const uint8_t v = static_cast<uint8_t>(std::clamp(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128, 0, 255));
      uint8_t *dst = yuy2 + (static_cast<size_t>(y) * width + x) * 2u;
      dst[0] = y0;
      dst[1] = u;
      dst[2] = y1;
      dst[3] = v;
    }
  }
}

LONGLONG qpcToSampleTime(uint64_t qpc, uint64_t baseQpc, LONGLONG baseSampleTime) {
  LARGE_INTEGER frequency{};
  QueryPerformanceFrequency(&frequency);
  if (qpc <= baseQpc || frequency.QuadPart <= 0) {
    return baseSampleTime;
  }
  const uint64_t delta = qpc - baseQpc;
  return baseSampleTime +
         static_cast<LONGLONG>((delta * 10000000ull) /
                               static_cast<uint64_t>(frequency.QuadPart));
}

HRESULT makeVideoType(const GUID &subtype, uint32_t width, uint32_t height,
                      DWORD stride, DWORD bytesPerPixel,
                      Microsoft::WRL::ComPtr<IMFMediaType> &type) {
  CK(MFCreateMediaType(&type));
  type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  type->SetGUID(MF_MT_SUBTYPE, subtype);
  type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, width, height);
  type->SetUINT32(MF_MT_DEFAULT_STRIDE, stride);
  MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kFrameRate, 1);
  MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  type->SetUINT32(MF_MT_AVG_BITRATE,
                  width * height * bytesPerPixel * 8 * kFrameRate);
  return S_OK;
}

HRESULT makeStreamDescriptor(uint32_t index, uint32_t width, uint32_t height,
                             bool offerNv12,
                             IMFStreamDescriptor **descriptor) {
  if (descriptor == nullptr) {
    return E_POINTER;
  }
  *descriptor = nullptr;
  Microsoft::WRL::ComPtr<IMFMediaType> rgb32Type;
  CK(makeVideoType(MFVideoFormat_RGB32, width, height, width * 4, 4,
                   rgb32Type));
  if (!offerNv12) {
    IMFMediaType *types[] = {rgb32Type.Get()};
    return MFCreateStreamDescriptor(index, 1, types, descriptor);
  }

  Microsoft::WRL::ComPtr<IMFMediaType> nv12Type;
  Microsoft::WRL::ComPtr<IMFMediaType> yuy2Type;
  CK(makeVideoType(MFVideoFormat_NV12, width, height, width, 1, nv12Type));
  CK(makeVideoType(MFVideoFormat_YUY2, width, height, width * 2, 2, yuy2Type));
  IMFMediaType *types[] = {rgb32Type.Get(), nv12Type.Get(), yuy2Type.Get()};
  return MFCreateStreamDescriptor(index, 3, types, descriptor);
}

}  // namespace

HRESULT MediaStream::Initialize(IMFMediaSource *source, int index,
                                RawFrameClient *client,
                                ShmFrameReader *shmReader,
                                uint32_t width,
                                uint32_t height) {
  if (!source || !client || !shmReader || width == 0 || height == 0) {
    return E_INVALIDARG;
  }
  _source = source;
  _index = index;
  _client = client;
  _shmReader = shmReader;
  _width = width;
  _height = height;

  CK(SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE));
  CK(SetUINT32(MF_DEVICESTREAM_STREAM_ID, index));
  CK(SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1));
  CK(SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
               MFFrameSourceTypes_Color));

  CK(MFCreateEventQueue(&_queue));

  _offerNv12 = readOfferNv12Flag();
  CK(makeStreamDescriptor(static_cast<uint32_t>(_index), _width, _height,
                          _offerNv12, &_descriptor));

  Microsoft::WRL::ComPtr<IMFMediaTypeHandler> handler;
  CK(_descriptor->GetMediaTypeHandler(&handler));
  Microsoft::WRL::ComPtr<IMFMediaType> rgb32Type;
  CK(handler->GetMediaTypeByIndex(0, &rgb32Type));
  CK(handler->SetCurrentMediaType(rgb32Type.Get()));
  if (_offerNv12) {
    VcamLog("MediaStream: OfferNv12 experiment enabled");
  }

  CK(createSampleBufferPool(MFVideoFormat_RGB32, _width, _height,
                            _sampleBuffers));
  _sampleBufferSubtype = MFVideoFormat_RGB32;
  return S_OK;
}

HRESULT MediaStream::Start() {
  try {
    RawFrameClient *client = nullptr;
    ShmFrameReader *shmReader = nullptr;
    {
      winrt::slim_lock_guard lock(_lock);
      if (!_queue) return MF_E_SHUTDOWN;
      CK(_queue->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr));
      _state = MF_STREAM_STATE_RUNNING;
      client = _client;
      shmReader = _shmReader;
    }
    if (shmReader) {
      shmReader->createServiceRing();
      shmReader->start();
    }
    if (client && (!shmReader || !shmReader->hasMapping())) {
      client->start();
      winrt::slim_lock_guard lock(_lock);
      _tcpRunning = true;
      VcamLog("vcam_reader_transport tcp reason=shm_unavailable_at_start");
    }
    VcamLog("MediaStream: running, shm reader active");
    return S_OK;
  } catch (...) {
    VcamLog("MediaStream::Start exception");
    return E_FAIL;
  }
}

HRESULT MediaStream::Stop() {
  try {
    RawFrameClient *client = nullptr;
    ShmFrameReader *shmReader = nullptr;
    {
      winrt::slim_lock_guard lock(_lock);
      if (!_queue) return MF_E_SHUTDOWN;
      CK(_queue->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr));
      _state = MF_STREAM_STATE_STOPPED;
      client = _client;
      shmReader = _shmReader;
      _tcpRunning = false;
      _loggedFirstSampleStreamType = false;
    }
    if (shmReader) {
      shmReader->stop();
      shmReader->closeServiceRing();
    }
    if (client) {
      client->stop();
    }
    VcamLog("MediaStream: stopped, transports disconnected");
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
      if (_shmReader) {
        _shmReader->stop();
        _shmReader->closeServiceRing();
      }
      _shmReader = nullptr;
      _descriptor.Reset();
      _sampleBuffers.clear();
      _lastSampleBuffer.Reset();
      _sampleBufferSubtype = GUID_NULL;
      _lastSequence = 0;
      _lastShmSequence = 0;
      _lastTcpSequence = 0;
      _lastShmReaderGeneration = 0;
      _baseCaptureNs = 0;
      _baseCaptureQpc = 0;
      _baseSampleTime = 0;
      _lastSampleTime = 0;
      _tcpRunning = false;
      _loggedFirstSampleStreamType = false;
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

    GUID subtype = MFVideoFormat_RGB32;
    if (_descriptor) {
      Microsoft::WRL::ComPtr<IMFMediaTypeHandler> handler;
      Microsoft::WRL::ComPtr<IMFMediaType> currentType;
      if (SUCCEEDED(_descriptor->GetMediaTypeHandler(&handler)) &&
          SUCCEEDED(handler->GetCurrentMediaType(&currentType))) {
        GUID selected = {};
        if (SUCCEEDED(currentType->GetGUID(MF_MT_SUBTYPE, &selected))) {
          subtype = selected;
        }
      }
    }
    const DWORD rgbFrameBytes = _width * _height * 4;
    const DWORD outputFrameBytes =
        sampleBytesForSubtype(subtype, _width, _height);
    const bool subtypeChanged =
        subtype != _sampleBufferSubtype || _sampleBuffers.empty();
    if (subtypeChanged) {
      CK(createSampleBufferPool(subtype, _width, _height, _sampleBuffers));
      _sampleBufferSubtype = subtype;
      _nextSampleBuffer = 0;
      _lastSampleBuffer.Reset();
      _hasLastGoodFrame = false;
    }
    if (!_loggedFirstSampleStreamType || subtypeChanged) {
      logStreamType(subtype);
      _loggedFirstSampleStreamType = true;
    }
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

    if (_shmReader) {
      const uint64_t shmGeneration = _shmReader->mappingGeneration();
      if (shmGeneration != _lastShmReaderGeneration) {
        _lastShmReaderGeneration = shmGeneration;
        _lastShmSequence = 0u;
      }
    }
    bool frameFromShm = false;
    bool hasNewFrame =
        _shmReader && _shmReader->copyLatestIfNew(_lastShmSequence, _scratchFrame);
    if (hasNewFrame) {
      frameFromShm = true;
      if (_client && _tcpRunning) {
        _client->stop();
        _tcpRunning = false;
        VcamLog("vcam_reader_transport shm reason=shm_frame_available");
      }
    } else {
      if (_client && !_tcpRunning &&
          (_shmReader == nullptr || !_shmReader->hasMapping())) {
        _client->start();
        _tcpRunning = true;
        VcamLog("vcam_reader_transport tcp reason=shm_unavailable");
      }
      hasNewFrame =
          _client && _client->copyLatestIfNew(_lastTcpSequence, _scratchFrame);
    }
    bool usePreviousSample = _hasLastGoodFrame;
    LONGLONG sampleTime =
        _hasLastGoodFrame ? _lastSampleTime + kFrameDuration : MFGetSystemTime();
    if (hasNewFrame && isWellFormed(_scratchFrame)) {
      Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer =
          _sampleBuffers[_nextSampleBuffer];
      _nextSampleBuffer = (_nextSampleBuffer + 1) % _sampleBuffers.size();
      BYTE *dst = nullptr;
      CK(buffer->Lock(&dst, nullptr, nullptr));
      std::vector<uint8_t> scaledBgra;
      const uint8_t *sourceBgra = _scratchFrame.bgra.data();
      if (_scratchFrame.width == _width && _scratchFrame.height == _height) {
        sourceBgra = _scratchFrame.bgra.data();
      } else {
        if (_scratchFrame.width != _loggedMismatchWidth ||
            _scratchFrame.height != _loggedMismatchHeight) {
          _loggedMismatchWidth = _scratchFrame.width;
          _loggedMismatchHeight = _scratchFrame.height;
          VcamLog(
              "MediaStream: source %ux%u differs from media type %ux%u, scaling",
              _scratchFrame.width, _scratchFrame.height, _width, _height);
        }
        scaledBgra.resize(rgbFrameBytes);
        scaleNearest(_scratchFrame.bgra.data(), _scratchFrame.width,
                     _scratchFrame.height, scaledBgra.data(), _width, _height);
        sourceBgra = scaledBgra.data();
      }
      if (subtype == MFVideoFormat_NV12) {
        broadify::vcam_shm::bgraToNv12(sourceBgra, _width, _height, dst,
                                       outputFrameBytes);
      } else if (subtype == MFVideoFormat_YUY2) {
        bgraToYuy2(sourceBgra, _width, _height, dst, outputFrameBytes);
      } else {
        std::memcpy(dst, sourceBgra, rgbFrameBytes);
      }
      buffer->Unlock();
      buffer->SetCurrentLength(outputFrameBytes);
      _lastSampleBuffer = buffer;
      _lastSequence = _scratchFrame.sequence;
      if (frameFromShm) {
        _lastShmSequence = _scratchFrame.sequence;
      } else {
        _lastTcpSequence = _scratchFrame.sequence;
      }
      _hasLastGoodFrame = true;
      usePreviousSample = true;
      if (_scratchFrame.captureNs > 0) {
        if (frameFromShm) {
          if (_baseCaptureQpc == 0 || _scratchFrame.captureNs < _baseCaptureQpc) {
            _baseCaptureQpc = _scratchFrame.captureNs;
            _baseSampleTime = MFGetSystemTime();
          }
          sampleTime =
              qpcToSampleTime(_scratchFrame.captureNs, _baseCaptureQpc,
                              _baseSampleTime);
        } else {
          if (_baseCaptureNs == 0 || _scratchFrame.captureNs < _baseCaptureNs) {
            _baseCaptureNs = _scratchFrame.captureNs;
            _baseSampleTime = MFGetSystemTime();
          }
          sampleTime =
              _baseSampleTime +
              static_cast<LONGLONG>((_scratchFrame.captureNs - _baseCaptureNs) /
                                    100u);
        }
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
      fillSplash(subtype, dst, outputFrameBytes, _width, _height);
      buffer->Unlock();
      buffer->SetCurrentLength(outputFrameBytes);
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
