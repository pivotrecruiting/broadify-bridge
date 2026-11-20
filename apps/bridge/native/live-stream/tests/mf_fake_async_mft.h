#pragma once

// In-test asynchronous encoder MFT for the Media Foundation encoder tests.
// It speaks the asynchronous MFT protocol the hardware encoders use
// (METransformNeedInput / METransformHaveOutput / METransformDrainComplete
// through IMFMediaEventGenerator, ICodecAPI for the settings, IMFShutdown) and
// either fabricates Annex B access units itself or wraps a synchronous MFT
// (`inner`), which turns that transform into an asynchronous one. Test code
// only: nothing here is linked into a helper.

#include <windows.h>

#include <cguid.h>
#include <codecapi.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mftransform.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace broadify::live::test {

using Microsoft::WRL::ComPtr;

struct FakeMftOptions {
  bool async = true;                 // MF_TRANSFORM_ASYNC on the attribute store
  bool providesSamples = false;      // MFT_OUTPUT_STREAM_PROVIDES_SAMPLES
  bool parameterSetsInBand = false;  // false: SPS/PPS only in MF_MT_MPEG_SEQUENCE_HEADER
  bool supportForceKeyframe = true;
  bool supportPeakVbr = true;        // CODECAPI_AVEncCommonMaxBitRate settable
  bool manualCredits = false;        // input is requested only through grantInput()
  bool rejectColorOnInputType = false;
  int streamChangeAtOutput = -1;     // this ProcessOutput call (0-based) answers MF_E_TRANSFORM_STREAM_CHANGE once
  HRESULT setOutputTypeResult = S_OK;
  ComPtr<IMFTransform> inner;        // synchronous MFT to wrap instead of fabricating output
};

// Parameter sets the fake publishes: Main profile first, another SPS after a stream change.
inline const std::vector<uint8_t> &fakeSps() {
  static const std::vector<uint8_t> sps = {0x67, 0x4d, 0x40, 0x1f, 0xaa};
  return sps;
}
inline const std::vector<uint8_t> &fakeSpsAfterChange() {
  static const std::vector<uint8_t> sps = {0x67, 0x4d, 0x40, 0x28, 0xbb};
  return sps;
}
inline const std::vector<uint8_t> &fakePps() {
  static const std::vector<uint8_t> pps = {0x68, 0xee, 0x3c, 0x80};
  return pps;
}

class FakeAsyncEncoderMft : public IMFTransform, public IMFMediaEventGenerator, public ICodecAPI, public IMFShutdown {
 public:
  explicit FakeAsyncEncoderMft(FakeMftOptions options) : options_(std::move(options)) {
    MFCreateAttributes(&attributes_, 4);
    attributes_->SetUINT32(MF_TRANSFORM_ASYNC, options_.async ? TRUE : FALSE);
    MFCreateEventQueue(&queue_);
    if (options_.inner) {
      options_.inner->QueryInterface(IID_PPV_ARGS(&innerCodecApi_));
    }
  }
  virtual ~FakeAsyncEncoderMft() = default;

  // --- observations for the tests -------------------------------------------

  struct CodecValue {
    GUID api;
    ULONG number;
  };

  struct State {
    bool asyncUnlocked = false;
    bool lowLatencyAttribute = false;
    bool outputTypeSetBeforeInputType = false;
    bool inputIsNv12 = false;
    bool inputColorSignalled = false;
    UINT32 inputWidth = 0;
    UINT32 inputHeight = 0;
    UINT32 outputProfile = 0;
    UINT32 outputBitrate = 0;
    uint64_t inputs = 0;
    uint64_t outputs = 0;
    uint64_t forcedKeyframes = 0;
    uint64_t drains = 0;
    uint64_t startOfStream = 0;
    uint64_t beginStreaming = 0;
    uint64_t notAccepting = 0;
    bool shutdown = false;
    DWORD lastInputLength = 0;
    uint8_t lastInputFirstByte = 0;
    IMFMediaBuffer *lastInputBuffer = nullptr;  // identity only, never dereferenced
    std::vector<LONGLONG> inputTimes;
  };

  State state() {
    std::lock_guard<std::mutex> lock(mutex_);
    State copy = state_;
    UINT32 value = 0;
    copy.asyncUnlocked = SUCCEEDED(attributes_->GetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, &value)) && value != 0;
    value = 0;
    copy.lowLatencyAttribute = SUCCEEDED(attributes_->GetUINT32(MF_LOW_LATENCY, &value)) && value != 0;
    return copy;
  }

  /** Last value set through ICodecAPI for `api`; false when it was never set. */
  bool codecValue(const GUID &api, ULONG &number) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = codecValues_.rbegin(); it != codecValues_.rend(); ++it) {
      if (IsEqualGUID(it->api, api)) {
        number = it->number;
        return true;
      }
    }
    return false;
  }

  /** Lets the MFT request `count` more inputs (manualCredits). */
  void grantInput(uint32_t count) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (uint32_t i = 0; i < count; ++i) {
      requestInputLocked();
    }
  }

  // --- IUnknown --------------------------------------------------------------

  STDMETHODIMP QueryInterface(REFIID riid, void **object) override {
    if (object == nullptr) {
      return E_POINTER;
    }
    *object = nullptr;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMFTransform)) {
      *object = static_cast<IMFTransform *>(this);
    } else if (riid == __uuidof(IMFMediaEventGenerator)) {
      *object = static_cast<IMFMediaEventGenerator *>(this);
    } else if (riid == __uuidof(ICodecAPI)) {
      *object = static_cast<ICodecAPI *>(this);
    } else if (riid == __uuidof(IMFShutdown)) {
      *object = static_cast<IMFShutdown *>(this);
    } else {
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG refs = --refs_;
    if (refs == 0) {
      delete this;
    }
    return refs;
  }

  // --- IMFTransform ----------------------------------------------------------

  STDMETHODIMP GetStreamLimits(DWORD *inputMin, DWORD *inputMax, DWORD *outputMin, DWORD *outputMax) override {
    *inputMin = *inputMax = *outputMin = *outputMax = 1;
    return S_OK;
  }
  STDMETHODIMP GetStreamCount(DWORD *inputs, DWORD *outputs) override {
    *inputs = *outputs = 1;
    return S_OK;
  }
  STDMETHODIMP GetStreamIDs(DWORD, DWORD *, DWORD, DWORD *) override { return E_NOTIMPL; }
  STDMETHODIMP GetInputStreamInfo(DWORD, MFT_INPUT_STREAM_INFO *info) override {
    *info = {};
    return S_OK;
  }
  STDMETHODIMP GetOutputStreamInfo(DWORD, MFT_OUTPUT_STREAM_INFO *info) override {
    *info = {};
    info->dwFlags = MFT_OUTPUT_STREAM_WHOLE_SAMPLES | MFT_OUTPUT_STREAM_SINGLE_SAMPLE_PER_BUFFER;
    if (options_.providesSamples || options_.inner) {
      info->dwFlags |= MFT_OUTPUT_STREAM_PROVIDES_SAMPLES;
    }
    info->cbSize = 64 * 1024;
    return S_OK;
  }
  STDMETHODIMP GetAttributes(IMFAttributes **attributes) override {
    *attributes = attributes_.Get();
    (*attributes)->AddRef();
    return S_OK;
  }
  STDMETHODIMP GetInputStreamAttributes(DWORD, IMFAttributes **) override { return E_NOTIMPL; }
  STDMETHODIMP GetOutputStreamAttributes(DWORD, IMFAttributes **) override { return E_NOTIMPL; }
  STDMETHODIMP DeleteInputStream(DWORD) override { return E_NOTIMPL; }
  STDMETHODIMP AddInputStreams(DWORD, DWORD *) override { return E_NOTIMPL; }
  STDMETHODIMP GetInputAvailableType(DWORD, DWORD, IMFMediaType **) override { return E_NOTIMPL; }
  STDMETHODIMP GetOutputAvailableType(DWORD stream, DWORD index, IMFMediaType **type) override {
    if (options_.inner) {
      return options_.inner->GetOutputAvailableType(stream, index, type);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (index != 0 || !offeredOutputType_) {
      return MF_E_NO_MORE_TYPES;
    }
    *type = offeredOutputType_.Get();
    (*type)->AddRef();
    return S_OK;
  }
  STDMETHODIMP SetInputType(DWORD stream, IMFMediaType *type, DWORD flags) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!outputType_) {
      return MF_E_TRANSFORM_TYPE_NOT_SET;
    }
    UINT32 range = 0;
    const bool color = SUCCEEDED(type->GetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, &range));
    if (color && options_.rejectColorOnInputType) {
      return MF_E_INVALIDMEDIATYPE;
    }
    if (options_.inner) {
      const HRESULT hr = options_.inner->SetInputType(stream, type, flags);
      if (FAILED(hr)) {
        return hr;
      }
    }
    GUID subtype = GUID_NULL;
    type->GetGUID(MF_MT_SUBTYPE, &subtype);
    UINT32 matrix = 0;
    type->GetUINT32(MF_MT_YUV_MATRIX, &matrix);
    state_.inputIsNv12 = IsEqualGUID(subtype, MFVideoFormat_NV12) != 0;
    state_.inputColorSignalled = color && range == MFNominalRange_16_235 && matrix == MFVideoTransferMatrix_BT709;
    MFGetAttributeSize(type, MF_MT_FRAME_SIZE, &state_.inputWidth, &state_.inputHeight);
    state_.outputTypeSetBeforeInputType = true;
    inputType_ = type;
    return S_OK;
  }
  STDMETHODIMP SetOutputType(DWORD stream, IMFMediaType *type, DWORD flags) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (FAILED(options_.setOutputTypeResult)) {
      return options_.setOutputTypeResult;
    }
    if (options_.inner) {
      const HRESULT hr = options_.inner->SetOutputType(stream, type, flags);
      if (FAILED(hr)) {
        return hr;
      }
    } else if (type != offeredOutputType_.Get()) {
      // The encoder publishes its parameter sets on the output type.
      setSequenceHeader(type, fakeSps());
    }
    type->GetUINT32(MF_MT_MPEG2_PROFILE, &state_.outputProfile);
    type->GetUINT32(MF_MT_AVG_BITRATE, &state_.outputBitrate);
    outputType_ = type;
    return S_OK;
  }
  STDMETHODIMP GetInputCurrentType(DWORD, IMFMediaType **type) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!inputType_) {
      return MF_E_TRANSFORM_TYPE_NOT_SET;
    }
    *type = inputType_.Get();
    (*type)->AddRef();
    return S_OK;
  }
  STDMETHODIMP GetOutputCurrentType(DWORD stream, IMFMediaType **type) override {
    if (options_.inner) {
      return options_.inner->GetOutputCurrentType(stream, type);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (!outputType_) {
      return MF_E_TRANSFORM_TYPE_NOT_SET;
    }
    *type = outputType_.Get();
    (*type)->AddRef();
    return S_OK;
  }
  STDMETHODIMP GetInputStatus(DWORD, DWORD *) override { return E_NOTIMPL; }
  STDMETHODIMP GetOutputStatus(DWORD *) override { return E_NOTIMPL; }
  STDMETHODIMP SetOutputBounds(LONGLONG, LONGLONG) override { return E_NOTIMPL; }
  STDMETHODIMP ProcessEvent(DWORD, IMFMediaEvent *) override { return E_NOTIMPL; }

  STDMETHODIMP ProcessMessage(MFT_MESSAGE_TYPE message, ULONG_PTR param) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_.shutdown) {
      return MF_E_SHUTDOWN;
    }
    switch (message) {
      case MFT_MESSAGE_NOTIFY_BEGIN_STREAMING:
        ++state_.beginStreaming;
        if (options_.inner) options_.inner->ProcessMessage(message, param);
        break;
      case MFT_MESSAGE_NOTIFY_START_OF_STREAM:
        ++state_.startOfStream;
        if (options_.inner) options_.inner->ProcessMessage(message, param);
        awaitingStart_ = false;
        if (!options_.manualCredits && credits_ == 0) {
          requestInputLocked();
        }
        break;
      case MFT_MESSAGE_COMMAND_DRAIN:
        // A drain takes back every outstanding input request.
        credits_ = 0;
        draining_ = true;
        if (options_.inner) {
          options_.inner->ProcessMessage(message, param);
          pullInnerLocked();
        }
        finishDrainIfIdleLocked();
        break;
      case MFT_MESSAGE_COMMAND_FLUSH:
        pending_.clear();
        if (options_.inner) options_.inner->ProcessMessage(message, param);
        break;
      default:
        if (options_.inner) options_.inner->ProcessMessage(message, param);
        break;
    }
    return S_OK;
  }

  STDMETHODIMP ProcessInput(DWORD stream, IMFSample *sample, DWORD flags) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_.shutdown) {
      return MF_E_SHUTDOWN;
    }
    if (!inputType_ || !outputType_) {
      return MF_E_TRANSFORM_TYPE_NOT_SET;
    }
    if (sample == nullptr) {
      return E_POINTER;
    }
    if (credits_ == 0) {
      ++state_.notAccepting;
      return MF_E_NOTACCEPTING;
    }
    --credits_;
    LONGLONG time = 0;
    sample->GetSampleTime(&time);
    ComPtr<IMFMediaBuffer> buffer;
    if (SUCCEEDED(sample->GetBufferByIndex(0, &buffer)) && buffer) {
      state_.lastInputBuffer = buffer.Get();
      BYTE *data = nullptr;
      DWORD length = 0;
      if (SUCCEEDED(buffer->Lock(&data, nullptr, &length))) {
        state_.lastInputLength = length;
        state_.lastInputFirstByte = length > 0 ? data[0] : 0;
        buffer->Unlock();
      }
    }
    state_.inputTimes.push_back(time);
    const uint64_t index = state_.inputs++;
    if (options_.inner) {
      const HRESULT hr = options_.inner->ProcessInput(stream, sample, flags);
      if (FAILED(hr)) {
        return hr;
      }
      pullInnerLocked();
    } else {
      const bool keyframe = index == 0 || forceNext_ || (gopFrames_ > 0 && framesSinceKeyframe_ >= gopFrames_);
      if (forceNext_) {
        ++state_.forcedKeyframes;
        forceNext_ = false;
      }
      framesSinceKeyframe_ = keyframe ? 1 : framesSinceKeyframe_ + 1;
      pending_.push_back(makeAccessUnit(index, keyframe, time));
      queueEventLocked(METransformHaveOutput);
    }
    if (!options_.manualCredits && !draining_ && !awaitingStart_) {
      requestInputLocked();
    }
    return S_OK;
  }

  STDMETHODIMP ProcessOutput(DWORD, DWORD count, MFT_OUTPUT_DATA_BUFFER *samples, DWORD *status) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_.shutdown) {
      return MF_E_SHUTDOWN;
    }
    if (count != 1 || samples == nullptr || status == nullptr) {
      return E_INVALIDARG;
    }
    *status = 0;
    if (!outputType_) {
      return MF_E_TRANSFORM_TYPE_NOT_SET;
    }
    if (pending_.empty()) {
      // An asynchronous MFT has no output without a METransformHaveOutput.
      return E_UNEXPECTED;
    }
    const bool mftAllocates = options_.providesSamples || options_.inner;
    if (mftAllocates != (samples[0].pSample == nullptr)) {
      return E_INVALIDARG;
    }
    if (!streamChanged_ && options_.streamChangeAtOutput >= 0 &&
        outputCalls_ == static_cast<uint64_t>(options_.streamChangeAtOutput)) {
      streamChanged_ = true;
      ++outputCalls_;
      // The output type has to be set again; later keyframes come with the new parameter sets.
      outputType_.Reset();
      MFCreateMediaType(&offeredOutputType_);
      offeredOutputType_->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
      offeredOutputType_->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
      setSequenceHeader(offeredOutputType_.Get(), fakeSpsAfterChange());
      samples[0].dwStatus = MFT_OUTPUT_DATA_BUFFER_FORMAT_CHANGE;
      return MF_E_TRANSFORM_STREAM_CHANGE;
    }
    ++outputCalls_;
    ComPtr<IMFSample> produced = pending_.front();
    pending_.pop_front();
    if (mftAllocates) {
      samples[0].pSample = produced.Detach();
    } else {
      const HRESULT hr = copySample(produced.Get(), samples[0].pSample);
      if (FAILED(hr)) {
        return hr;
      }
    }
    ++state_.outputs;
    finishDrainIfIdleLocked();
    return S_OK;
  }

  // --- IMFMediaEventGenerator --------------------------------------------------

  STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent **event) override { return queue_->GetEvent(flags, event); }
  STDMETHODIMP BeginGetEvent(IMFAsyncCallback *callback, IUnknown *state) override {
    return queue_->BeginGetEvent(callback, state);
  }
  STDMETHODIMP EndGetEvent(IMFAsyncResult *result, IMFMediaEvent **event) override {
    return queue_->EndGetEvent(result, event);
  }
  STDMETHODIMP QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status, const PROPVARIANT *value) override {
    return queue_->QueueEventParamVar(type, extendedType, status, value);
  }

  // --- IMFShutdown -------------------------------------------------------------

  STDMETHODIMP Shutdown() override {
    std::lock_guard<std::mutex> lock(mutex_);
    state_.shutdown = true;
    pending_.clear();
    return queue_->Shutdown();
  }
  STDMETHODIMP GetShutdownStatus(MFSHUTDOWN_STATUS *status) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!state_.shutdown) {
      return MF_E_INVALIDREQUEST;
    }
    *status = MFSHUTDOWN_COMPLETED;
    return S_OK;
  }

  // --- ICodecAPI ---------------------------------------------------------------

  STDMETHODIMP IsSupported(const GUID *api) override {
    if (api == nullptr) {
      return E_POINTER;
    }
    if (IsEqualGUID(*api, CODECAPI_AVEncVideoForceKeyFrame) && !options_.supportForceKeyframe) {
      return E_NOTIMPL;
    }
    if (IsEqualGUID(*api, CODECAPI_AVEncCommonMaxBitRate) && !options_.supportPeakVbr) {
      return E_NOTIMPL;
    }
    if (innerCodecApi_) {
      return innerCodecApi_->IsSupported(api);
    }
    return S_OK;
  }
  STDMETHODIMP IsModifiable(const GUID *) override { return S_OK; }
  STDMETHODIMP GetParameterRange(const GUID *, VARIANT *, VARIANT *, VARIANT *) override { return E_NOTIMPL; }
  STDMETHODIMP GetParameterValues(const GUID *, VARIANT **, ULONG *) override { return E_NOTIMPL; }
  STDMETHODIMP GetDefaultValue(const GUID *, VARIANT *) override { return E_NOTIMPL; }
  STDMETHODIMP GetValue(const GUID *, VARIANT *) override { return E_NOTIMPL; }
  STDMETHODIMP SetValue(const GUID *api, VARIANT *value) override {
    if (api == nullptr || value == nullptr) {
      return E_POINTER;
    }
    if (IsSupported(api) != S_OK) {
      return E_NOTIMPL;
    }
    if (innerCodecApi_) {
      const HRESULT hr = innerCodecApi_->SetValue(api, value);
      if (FAILED(hr)) {
        return hr;
      }
    }
    const ULONG number = value->vt == VT_BOOL ? (value->boolVal != VARIANT_FALSE ? 1u : 0u) : value->ulVal;
    std::lock_guard<std::mutex> lock(mutex_);
    codecValues_.push_back({*api, number});
    if (IsEqualGUID(*api, CODECAPI_AVEncVideoForceKeyFrame)) {
      forceNext_ = number != 0;
      if (innerCodecApi_ && forceNext_) {
        ++state_.forcedKeyframes;
        forceNext_ = false;
      }
    } else if (IsEqualGUID(*api, CODECAPI_AVEncMPVGOPSize)) {
      gopFrames_ = number;
    }
    return S_OK;
  }
  STDMETHODIMP RegisterForEvent(const GUID *, LONG_PTR) override { return E_NOTIMPL; }
  STDMETHODIMP UnregisterForEvent(const GUID *) override { return E_NOTIMPL; }
  STDMETHODIMP SetAllDefaults() override { return E_NOTIMPL; }
  STDMETHODIMP SetValueWithNotify(const GUID *, VARIANT *, GUID **, ULONG *) override { return E_NOTIMPL; }
  STDMETHODIMP SetAllDefaultsWithNotify(GUID **, ULONG *) override { return E_NOTIMPL; }
  STDMETHODIMP GetAllSettings(IStream *) override { return E_NOTIMPL; }
  STDMETHODIMP SetAllSettings(IStream *) override { return E_NOTIMPL; }
  STDMETHODIMP SetAllSettingsWithNotify(IStream *, GUID **, ULONG *) override { return E_NOTIMPL; }

 private:
  static void appendNal(std::vector<uint8_t> &out, const std::vector<uint8_t> &nal) {
    out.insert(out.end(), {0, 0, 0, 1});
    out.insert(out.end(), nal.begin(), nal.end());
  }

  static void setSequenceHeader(IMFMediaType *type, const std::vector<uint8_t> &sps) {
    std::vector<uint8_t> header;
    appendNal(header, sps);
    appendNal(header, fakePps());
    type->SetBlob(MF_MT_MPEG_SEQUENCE_HEADER, header.data(), static_cast<UINT32>(header.size()));
  }

  static HRESULT makeSample(const std::vector<uint8_t> &bytes, LONGLONG time, bool keyframe, IMFSample **out) {
    ComPtr<IMFMediaBuffer> buffer;
    HRESULT hr = MFCreateMemoryBuffer(static_cast<DWORD>(bytes.size()), &buffer);
    if (FAILED(hr)) {
      return hr;
    }
    BYTE *data = nullptr;
    hr = buffer->Lock(&data, nullptr, nullptr);
    if (FAILED(hr)) {
      return hr;
    }
    memcpy(data, bytes.data(), bytes.size());
    buffer->Unlock();
    buffer->SetCurrentLength(static_cast<DWORD>(bytes.size()));
    ComPtr<IMFSample> sample;
    hr = MFCreateSample(&sample);
    if (FAILED(hr)) {
      return hr;
    }
    sample->AddBuffer(buffer.Get());
    sample->SetSampleTime(time);
    if (keyframe) {
      sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
    }
    *out = sample.Detach();
    return S_OK;
  }

  // Copies an access unit into the caller's sample (the MFT does not provide samples).
  static HRESULT copySample(IMFSample *from, IMFSample *to) {
    ComPtr<IMFMediaBuffer> source;
    ComPtr<IMFMediaBuffer> target;
    HRESULT hr = from->GetBufferByIndex(0, &source);
    if (SUCCEEDED(hr)) hr = to->GetBufferByIndex(0, &target);
    if (FAILED(hr)) {
      return hr;
    }
    BYTE *sourceData = nullptr;
    BYTE *targetData = nullptr;
    DWORD length = 0;
    DWORD capacity = 0;
    hr = source->Lock(&sourceData, nullptr, &length);
    if (FAILED(hr)) {
      return hr;
    }
    hr = target->Lock(&targetData, &capacity, nullptr);
    if (SUCCEEDED(hr)) {
      if (capacity >= length) {
        memcpy(targetData, sourceData, length);
      } else {
        hr = MF_E_BUFFERTOOSMALL;
      }
      target->Unlock();
    }
    source->Unlock();
    if (FAILED(hr)) {
      return hr;
    }
    target->SetCurrentLength(length);
    LONGLONG time = 0;
    if (SUCCEEDED(from->GetSampleTime(&time))) {
      to->SetSampleTime(time);
    }
    UINT32 cleanPoint = 0;
    if (SUCCEEDED(from->GetUINT32(MFSampleExtension_CleanPoint, &cleanPoint))) {
      to->SetUINT32(MFSampleExtension_CleanPoint, cleanPoint);
    }
    return S_OK;
  }

  ComPtr<IMFSample> makeAccessUnit(uint64_t index, bool keyframe, LONGLONG time) {
    std::vector<uint8_t> bytes;
    if (keyframe && options_.parameterSetsInBand) {
      appendNal(bytes, streamChanged_ ? fakeSpsAfterChange() : fakeSps());
      appendNal(bytes, fakePps());
    }
    const uint8_t header = keyframe ? 0x65 : 0x41;
    appendNal(bytes, {header, static_cast<uint8_t>(0x80 | (index & 0x3f)), 0x42, 0x42});
    ComPtr<IMFSample> sample;
    makeSample(bytes, time, keyframe, &sample);
    return sample;
  }

  void queueEventLocked(MediaEventType type) { queue_->QueueEventParamVar(type, GUID_NULL, S_OK, nullptr); }

  void requestInputLocked() {
    ++credits_;
    queueEventLocked(METransformNeedInput);
  }

  void finishDrainIfIdleLocked() {
    if (draining_ && pending_.empty()) {
      draining_ = false;
      // No further input request until the next MFT_MESSAGE_NOTIFY_START_OF_STREAM.
      awaitingStart_ = true;
      ++state_.drains;
      queueEventLocked(METransformDrainComplete);
    }
  }

  // Wrapped synchronous MFT: pull everything it has ready and announce it.
  void pullInnerLocked() {
    for (;;) {
      MFT_OUTPUT_STREAM_INFO info = {};
      if (FAILED(options_.inner->GetOutputStreamInfo(0, &info))) {
        return;
      }
      ComPtr<IMFSample> sample;
      ComPtr<IMFMediaBuffer> buffer;
      const DWORD size = info.cbSize > 0 ? info.cbSize : 4 * 1024 * 1024;
      if (FAILED(MFCreateMemoryBuffer(size, &buffer)) || FAILED(MFCreateSample(&sample)) ||
          FAILED(sample->AddBuffer(buffer.Get()))) {
        return;
      }
      MFT_OUTPUT_DATA_BUFFER output = {};
      output.pSample = sample.Get();
      DWORD status = 0;
      const HRESULT hr = options_.inner->ProcessOutput(0, 1, &output, &status);
      if (output.pEvents != nullptr) {
        output.pEvents->Release();
      }
      if (FAILED(hr)) {
        return;  // MF_E_TRANSFORM_NEED_MORE_INPUT: nothing ready
      }
      pending_.push_back(sample);
      queueEventLocked(METransformHaveOutput);
    }
  }

  const FakeMftOptions options_;
  std::atomic<ULONG> refs_{1};
  std::mutex mutex_;
  ComPtr<IMFAttributes> attributes_;
  ComPtr<IMFMediaEventQueue> queue_;
  ComPtr<ICodecAPI> innerCodecApi_;
  ComPtr<IMFMediaType> inputType_;
  ComPtr<IMFMediaType> outputType_;
  ComPtr<IMFMediaType> offeredOutputType_;
  std::deque<ComPtr<IMFSample>> pending_;
  std::vector<CodecValue> codecValues_;
  State state_;
  uint32_t credits_ = 0;
  bool draining_ = false;
  bool awaitingStart_ = false;
  bool forceNext_ = false;
  bool streamChanged_ = false;
  uint32_t gopFrames_ = 0;
  uint32_t framesSinceKeyframe_ = 0;
  uint64_t outputCalls_ = 0;
};

}  // namespace broadify::live::test
