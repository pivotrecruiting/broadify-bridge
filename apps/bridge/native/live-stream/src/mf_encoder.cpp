// Media Foundation hardware H.264 encoder (Windows side of vt_encoder.mm,
// ADR-0009). Hardware encoder MFTs only: the search is
// MFTEnumEx(MFT_ENUM_FLAG_HARDWARE), a transform that is not asynchronous is
// refused, and when no candidate can be configured `configure` fails with
// `encoder_unavailable` naming every tried encoder and its HRESULT. There is
// no software path in this file.
//
// Threads: one encoder thread per configured encoder owns the transform. It
// activates and configures it, receives the MFT's events (pumped into its
// queue by a small IMFAsyncCallback), feeds input when the MFT asked for it
// (METransformNeedInput credits), pulls output (METransformHaveOutput) and
// hands the access units to `onAccessUnit`. `encode` runs on the capture
// thread and never waits for the encoder: it converts the frame into an NV12
// sample and puts it into a one-slot mailbox; a frame still waiting there is
// replaced and counted as dropped.
//
// Input is NV12 in system memory (no D3D manager in v1). Output is Annex B
// with SPS/PPS in front of every keyframe, timestamps mapped back to the
// capture clock.

#if defined(_WIN32)

#include <windows.h>

#include <initguid.h>
// cguid.h must follow initguid.h so GUID_NULL is defined in this translation unit.
#include <cguid.h>

#include "mf_encoder_internal.h"

#include "helper_common/helper_event_log.h"
#include "live_stream/frame_to_nv12.h"
#include "live_stream/h264_annexb.h"
#include "live_stream/mf_encoder_policy.h"

#include <codecapi.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mftransform.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>

using Microsoft::WRL::ComPtr;

namespace broadify::live {
namespace {

// Activating and configuring up to a handful of driver MFTs; a hung driver must not hang the helper.
constexpr auto kOpenTimeout = std::chrono::seconds(15);
constexpr auto kFlushTimeout = std::chrono::seconds(2);
constexpr auto kTeardownTimeout = std::chrono::seconds(3);
// Input samples in flight: mailbox + what the MFT holds while encoding.
constexpr size_t kInputPoolSize = 6;
// Consecutive failed ProcessInput / ProcessOutput calls before the encoder reports failure.
constexpr uint32_t kMaxConsecutiveErrors = 30;

std::string hresultText(HRESULT hr) {
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "0x%08lX", static_cast<unsigned long>(static_cast<uint32_t>(hr)));
  return buffer;
}

std::string narrow(const wchar_t *text) {
  if (text == nullptr || *text == L'\0') {
    return {};
  }
  const int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) {
    return {};
  }
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, &out[0], size, nullptr, nullptr);
  out.resize(static_cast<size_t>(size) - 1);
  return out;
}

ULONG refCount(IUnknown *object) {
  object->AddRef();
  return object->Release();
}

// Media Foundation platform for as long as any encoder thread runs.
class MfRuntime {
 public:
  static HRESULT acquire() {
    std::lock_guard<std::mutex> lock(mutex());
    if (count() == 0) {
      const HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
      if (FAILED(hr)) {
        return hr;
      }
    }
    ++count();
    return S_OK;
  }
  static void release() {
    std::lock_guard<std::mutex> lock(mutex());
    if (count() > 0 && --count() == 0) {
      MFShutdown();
    }
  }

 private:
  static std::mutex &mutex() {
    static std::mutex instance;
    return instance;
  }
  static uint32_t &count() {
    static uint32_t instance = 0;
    return instance;
  }
};

bool setCodecValue(ICodecAPI *codec, const GUID &api, VARIANT &value) {
  if (codec == nullptr || codec->IsSupported(&api) != S_OK) {
    return false;
  }
  return SUCCEEDED(codec->SetValue(&api, &value));
}

bool setCodecUInt(ICodecAPI *codec, const GUID &api, uint32_t number) {
  VARIANT value{};
  value.vt = VT_UI4;
  value.ulVal = number;
  return setCodecValue(codec, api, value);
}

bool setCodecBool(ICodecAPI *codec, const GUID &api, bool flag) {
  VARIANT value{};
  value.vt = VT_BOOL;
  value.boolVal = flag ? VARIANT_TRUE : VARIANT_FALSE;
  return setCodecValue(codec, api, value);
}

uint32_t codecRateControlMode(RateControlMode mode) {
  switch (mode) {
    case RateControlMode::PeakConstrainedVbr:
      return eAVEncCommonRateControlMode_PeakConstrainedVBR;
    case RateControlMode::Cbr:
      return eAVEncCommonRateControlMode_CBR;
    case RateControlMode::UnconstrainedVbr:
      break;
  }
  return eAVEncCommonRateControlMode_UnconstrainedVBR;
}

// True when the encoder took the step. Peak-constrained VBR without a settable peak is not a hard cap: refused.
bool applyRateControl(ICodecAPI *codec, const RateControlStep &step, bool setMode) {
  if (setMode && !setCodecUInt(codec, CODECAPI_AVEncCommonRateControlMode, codecRateControlMode(step.mode))) {
    return false;
  }
  const bool mean = setCodecUInt(codec, CODECAPI_AVEncCommonMeanBitRate, step.meanBitrateBps);
  bool peak = true;
  if (step.maxBitrateBps > 0) {
    peak = setCodecUInt(codec, CODECAPI_AVEncCommonMaxBitRate, step.maxBitrateBps);
  }
  if (step.bufferBits > 0) {
    setCodecUInt(codec, CODECAPI_AVEncCommonBufferSize, step.bufferBits);
  }
  return mean && peak;
}

// What took effect on the chosen MFT; reported through EncoderInfo::settings.
struct AppliedSettings {
  bool codecApi = false;
  bool lowLatencyAttribute = false;
  bool lowLatency = false;
  bool rateControlSet = false;
  RateControlMode rateControl = RateControlMode::Cbr;
  bool gop = false;
  uint32_t gopFrames = 0;
  bool bFramesOff = false;
  bool cabac = false;
  bool qualityVsSpeed = false;
  bool forceKeyframe = false;
  bool colorSignalled = false;
};

const char *jsonBool(bool value) { return value ? "true" : "false"; }

std::string settingsJson(const AppliedSettings &applied) {
  return formatEncoderSettings({
      {"codec_api", jsonBool(applied.codecApi)},
      {"rate_control", applied.rateControlSet ? "\"" + std::string(rateControlModeName(applied.rateControl)) + "\""
                                              : std::string("\"default\"")},
      {"low_latency", jsonBool(applied.lowLatency || applied.lowLatencyAttribute)},
      {"gop_frames", applied.gop ? std::to_string(applied.gopFrames) : std::string("null")},
      {"b_frames_off", jsonBool(applied.bFramesOff)},
      {"cabac", jsonBool(applied.cabac)},
      {"quality_vs_speed", jsonBool(applied.qualityVsSpeed)},
      {"force_keyframe", jsonBool(applied.forceKeyframe)},
      {"color_signalled", jsonBool(applied.colorSignalled)},
  });
}

// Runs before and after the media types are set: drivers disagree on which
// order they accept, and a setting that took once stays reported as applied.
void applyCodecSettings(ICodecAPI *codec, const EncoderAttributePlan &plan, AppliedSettings &applied) {
  if (codec == nullptr) {
    return;
  }
  applied.codecApi = true;
  applied.forceKeyframe = applied.forceKeyframe || codec->IsSupported(&CODECAPI_AVEncVideoForceKeyFrame) == S_OK;
  if (!applied.rateControlSet) {
    for (const RateControlStep &step : plan.rateControl) {
      if (applyRateControl(codec, step, true)) {
        applied.rateControlSet = true;
        applied.rateControl = step.mode;
        break;
      }
    }
  } else {
    for (const RateControlStep &step : plan.rateControl) {
      if (step.mode == applied.rateControl) {
        applyRateControl(codec, step, true);
        break;
      }
    }
  }
  applied.lowLatency = setCodecBool(codec, CODECAPI_AVLowLatencyMode, plan.lowLatency) || applied.lowLatency;
  const uint32_t gopFrames = gopFramesFor(plan, applied.forceKeyframe);
  if (setCodecUInt(codec, CODECAPI_AVEncMPVGOPSize, gopFrames)) {
    applied.gop = true;
    applied.gopFrames = gopFrames;
  }
  applied.bFramesOff = setCodecUInt(codec, CODECAPI_AVEncMPVDefaultBPictureCount, plan.bFrames) || applied.bFramesOff;
  applied.cabac = setCodecBool(codec, CODECAPI_AVEncH264CABACEnable, plan.cabac) || applied.cabac;
  applied.qualityVsSpeed =
      setCodecUInt(codec, CODECAPI_AVEncCommonQualityVsSpeed, plan.qualityVsSpeed) || applied.qualityVsSpeed;
}

HRESULT setCommonVideoAttributes(IMFMediaType *type, const GUID &subtype, const EncoderAttributePlan &plan) {
  HRESULT hr = type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (SUCCEEDED(hr)) hr = type->SetGUID(MF_MT_SUBTYPE, subtype);
  if (SUCCEEDED(hr)) hr = MFSetAttributeSize(type, MF_MT_FRAME_SIZE, plan.width, plan.height);
  if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type, MF_MT_FRAME_RATE, plan.fpsNum, plan.fpsDen);
  if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  return hr;
}

HRESULT makeOutputType(const EncoderAttributePlan &plan, IMFMediaType **out) {
  ComPtr<IMFMediaType> type;
  HRESULT hr = MFCreateMediaType(&type);
  if (SUCCEEDED(hr)) hr = setCommonVideoAttributes(type.Get(), MFVideoFormat_H264, plan);
  if (SUCCEEDED(hr) && !plan.rateControl.empty()) {
    hr = type->SetUINT32(MF_MT_AVG_BITRATE, plan.rateControl.front().meanBitrateBps);
  }
  // eAVEncH264VProfile_Main / _High carry the profile_idc values.
  if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_MPEG2_PROFILE, plan.profileIdc);
  if (SUCCEEDED(hr)) *out = type.Detach();
  return hr;
}

// NV12, BT.709, video range (16-235): what the pixel modules of live_stream_core produce.
HRESULT makeInputType(const EncoderAttributePlan &plan, bool withColor, IMFMediaType **out) {
  ComPtr<IMFMediaType> type;
  HRESULT hr = MFCreateMediaType(&type);
  if (SUCCEEDED(hr)) hr = setCommonVideoAttributes(type.Get(), MFVideoFormat_NV12, plan);
  if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_DEFAULT_STRIDE, plan.width);
  if (SUCCEEDED(hr) && withColor) {
    hr = type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
    if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  }
  if (SUCCEEDED(hr)) *out = type.Detach();
  return hr;
}

void shutdownTransform(IMFTransform *transform) {
  if (transform == nullptr) {
    return;
  }
  // Asynchronous MFTs keep work-queue threads until IMFShutdown::Shutdown.
  ComPtr<IMFShutdown> shutdown;
  if (SUCCEEDED(transform->QueryInterface(IID_PPV_ARGS(&shutdown)))) {
    shutdown->Shutdown();
  }
}

class Session;

// Moves the MFT's events onto the encoder thread: Invoke runs on a Media
// Foundation work-queue thread and only queues the event and re-arms itself.
class EventPump : public IMFAsyncCallback {
 public:
  EventPump(std::weak_ptr<Session> session, IMFMediaEventGenerator *generator)
      : session_(std::move(session)), generator_(generator) {}

  STDMETHODIMP QueryInterface(REFIID riid, void **object) override {
    if (object == nullptr) {
      return E_POINTER;
    }
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMFAsyncCallback)) {
      *object = static_cast<IMFAsyncCallback *>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG refs = --refs_;
    if (refs == 0) {
      delete this;
    }
    return refs;
  }
  STDMETHODIMP GetParameters(DWORD *, DWORD *) override { return E_NOTIMPL; }
  STDMETHODIMP Invoke(IMFAsyncResult *result) override;

  HRESULT start() {
    std::lock_guard<std::mutex> lock(mutex_);
    return generator_ ? generator_->BeginGetEvent(this, nullptr) : E_UNEXPECTED;
  }

  // After this returns no further event reaches the session.
  void detach() {
    std::lock_guard<std::mutex> lock(mutex_);
    generator_.Reset();
    session_.reset();
  }

  virtual ~EventPump() = default;

 private:
  std::atomic<ULONG> refs_{1};
  std::mutex mutex_;
  std::weak_ptr<Session> session_;
  ComPtr<IMFMediaEventGenerator> generator_;
};

class Session : public std::enable_shared_from_this<Session> {
 public:
  Session(MfEncoderEnumerator enumerator, EncoderVendor preferred, const EncoderAttributePlan &plan, VideoEncoder *owner)
      : enumerator_(std::move(enumerator)), preferred_(preferred), plan_(plan), owner_(owner) {}

  // --- encoder thread -------------------------------------------------------

  void run() {
    // MTA for the lifetime of the thread: the capture thread that builds input
    // samples and the MFT's own threads share it implicitly.
    const HRESULT comHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const HRESULT mfHr = MfRuntime::acquire();
    bool opened = false;
    if (FAILED(mfHr)) {
      std::lock_guard<std::mutex> lock(mutex_);
      error_ = "No hardware H.264 encoder is available (MFStartup " + hresultText(mfHr) + ").";
    } else {
      opened = open();
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      opened_ = opened;
      openFinished_ = true;
    }
    done_.notify_all();
    if (opened) {
      loop();
    }
    close();
    if (SUCCEEDED(mfHr)) {
      MfRuntime::release();
    }
    if (SUCCEEDED(comHr)) {
      CoUninitialize();
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      exited_ = true;
    }
    done_.notify_all();
  }

  // --- any thread -----------------------------------------------------------

  bool waitOpened(std::string &error, EncoderInfo &info) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!done_.wait_for(lock, kOpenTimeout, [&] { return openFinished_; })) {
      error = "No hardware H.264 encoder is available (configuring the encoder did not finish in time).";
      return false;
    }
    if (!opened_) {
      error = error_;
      return false;
    }
    info = info_;
    return true;
  }

  // False when the encoder thread did not come back in time (a driver call hangs).
  bool stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stop_ = true;
    }
    wake_.notify_all();
    done_.notify_all();
    bool exited = false;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      exited = done_.wait_for(lock, kTeardownTimeout, [&] { return exited_; });
    }
    // Waits for a running onAccessUnit call; afterwards the encoder object may go away.
    std::lock_guard<std::mutex> lock(ownerMutex_);
    owner_ = nullptr;
    return exited;
  }

  bool enqueue(const CapturedFrame &frame, bool forceKeyframe) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!opened_ || stop_ || failed_) {
        return false;
      }
    }
    Input input;
    input.forceKeyframe = forceKeyframe || forceNext_.exchange(false);
    input.captureNs = frame.captureNs;
    if (!buildInputSample(frame, input.sample)) {
      if (input.forceKeyframe) {
        forceNext_.store(true);
      }
      std::lock_guard<std::mutex> lock(mutex_);
      ++stats_.rejected;
      return false;
    }
    input.sample->SetSampleTime(CaptureTimestampMap::sampleTimeFor(frame.captureNs));
    input.sample->SetSampleDuration(plan_.frameDurationHns);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stop_ || failed_) {
        if (input.forceKeyframe) {
          forceNext_.store(true);
        }
        return false;
      }
      ++stats_.received;
      if (mailbox_.sample) {
        // The encoder has not asked for input since: the newer frame wins.
        ++stats_.dropped;
        input.forceKeyframe = input.forceKeyframe || mailbox_.forceKeyframe;
      }
      mailbox_ = std::move(input);
    }
    wake_.notify_all();
    return true;
  }

  void setBitrate(uint32_t bitrateKbps, uint32_t maxBitrateKbps) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      bitratePending_ = true;
      pendingBitrateKbps_ = bitrateKbps;
      pendingMaxBitrateKbps_ = maxBitrateKbps;
    }
    wake_.notify_all();
  }

  void requestKeyframe() { forceNext_.store(true); }

  void flush() {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!opened_ || stop_ || failed_) {
      return;
    }
    flushRequested_ = true;
    wake_.notify_all();
    done_.wait_for(lock, kFlushTimeout, [&] { return !flushRequested_ || stop_ || failed_; });
  }

  MfEncoderStats stats() {
    std::lock_guard<std::mutex> lock(mutex_);
    return stats_;
  }

  // --- event pump (Media Foundation work-queue thread) ----------------------

  void pushEvent(ComPtr<IMFMediaEvent> event) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      events_.push_back(std::move(event));
    }
    wake_.notify_all();
  }

  void eventFailure(HRESULT hr) {
    if (hr == MF_E_SHUTDOWN) {
      return;
    }
    fail("events", hr);
  }

 private:
  struct Input {
    ComPtr<IMFSample> sample;
    bool forceKeyframe = false;
    uint64_t captureNs = 0;
  };

  struct PooledSample {
    ComPtr<IMFSample> sample;
    ComPtr<IMFMediaBuffer> buffer;
    // Reference counts while only the pool refers to the pair.
    ULONG idleSampleRefs = 0;
    ULONG idleBufferRefs = 0;
  };

  void fail(const char *stage, HRESULT hr) {
    bool first = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stop_) {
        return;
      }
      first = !failed_;
      failed_ = true;
      flushRequested_ = false;
    }
    wake_.notify_all();
    done_.notify_all();
    if (first) {
      broadify::helper::emitHelperEvent("{\"type\":\"mf_encoder_error\",\"stage\":\"" + std::string(stage) +
                                        "\",\"hresult\":\"" + hresultText(hr) + "\"}");
    }
  }

  bool stopRequested() {
    std::lock_guard<std::mutex> lock(mutex_);
    return stop_;
  }

  // Tries the candidates in policy order; the first one that configures wins.
  bool open() {
    std::vector<MfEncoderCandidate> candidates;
    const HRESULT enumHr = enumerator_ ? enumerator_(candidates) : E_POINTER;
    std::vector<EncoderAttempt> attempts;
    size_t chosen = candidates.size();
    if (SUCCEEDED(enumHr)) {
      std::vector<EncoderCandidateInfo> infos;
      infos.reserve(candidates.size());
      for (const MfEncoderCandidate &candidate : candidates) {
        infos.push_back({candidate.name, candidate.vendorId});
      }
      for (const size_t index : rankEncoderCandidates(infos, preferred_)) {
        if (stopRequested()) {
          break;
        }
        EncoderAttempt attempt;
        attempt.name = candidates[index].name;
        HRESULT hr = S_OK;
        if (openCandidate(candidates[index], attempt.stage, hr)) {
          chosen = index;
          break;
        }
        attempt.hresult = static_cast<uint32_t>(hr);
        attempts.push_back(std::move(attempt));
      }
    }
    for (size_t i = 0; i < candidates.size(); ++i) {
      if (i == chosen) {
        candidateShutdown_ = candidates[i].shutdown;
      } else if (candidates[i].shutdown) {
        candidates[i].shutdown();
      }
    }
    if (chosen == candidates.size()) {
      std::lock_guard<std::mutex> lock(mutex_);
      error_ = formatEncoderUnavailable(attempts, static_cast<uint32_t>(enumHr));
      return false;
    }
    return true;
  }

  bool openCandidate(const MfEncoderCandidate &candidate, std::string &stage, HRESULT &hr) {
    ComPtr<IMFTransform> transform;
    stage = "activate";
    hr = candidate.activate ? candidate.activate(&transform) : E_POINTER;
    if (SUCCEEDED(hr) && !transform) {
      hr = E_POINTER;
    }
    if (FAILED(hr)) {
      return false;
    }
    AppliedSettings applied;
    if (!configureTransform(transform.Get(), applied, stage, hr)) {
      if (pump_) {
        pump_->detach();
        pump_.Reset();
      }
      shutdownTransform(transform.Get());
      codecApi_.Reset();
      transform_.Reset();
      parameterSets_ = H264ParameterSets();
      std::lock_guard<std::mutex> lock(mutex_);
      events_.clear();
      credits_ = 0;
      return false;
    }
    applied_ = applied;
    std::lock_guard<std::mutex> lock(mutex_);
    info_.backend = "mediafoundation";
    info_.hardware = candidate.hardware;
    info_.name = candidate.name;
    info_.vendorId = candidate.vendorId;
    info_.settings = settingsJson(applied);
    return true;
  }

  bool configureTransform(IMFTransform *transform, AppliedSettings &applied, std::string &stage, HRESULT &hr) {
    ComPtr<IMFAttributes> attributes;
    stage = "attributes";
    hr = transform->GetAttributes(&attributes);
    if (SUCCEEDED(hr) && !attributes) {
      hr = E_POINTER;
    }
    if (FAILED(hr)) {
      return false;
    }
    // Hardware encoder MFTs are asynchronous by contract; anything else is not one.
    UINT32 async = FALSE;
    stage = "async_required";
    hr = attributes->GetUINT32(MF_TRANSFORM_ASYNC, &async);
    if (SUCCEEDED(hr) && !async) {
      hr = E_NOINTERFACE;
    }
    if (FAILED(hr)) {
      return false;
    }
    stage = "async_unlock";
    hr = attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
    if (FAILED(hr)) {
      return false;
    }
    applied.lowLatencyAttribute = SUCCEEDED(attributes->SetUINT32(MF_LOW_LATENCY, TRUE));

    ComPtr<IMFMediaEventGenerator> generator;
    stage = "event_generator";
    hr = transform->QueryInterface(IID_PPV_ARGS(&generator));
    if (FAILED(hr)) {
      return false;
    }
    ComPtr<ICodecAPI> codecApi;
    transform->QueryInterface(IID_PPV_ARGS(&codecApi));

    stage = "stream_ids";
    DWORD inputId = 0;
    DWORD outputId = 0;
    hr = transform->GetStreamIDs(1, &inputId, 1, &outputId);
    if (hr == E_NOTIMPL) {
      // Fixed streams numbered from 0.
      inputId = 0;
      outputId = 0;
    } else if (FAILED(hr)) {
      return false;
    }

    applyCodecSettings(codecApi.Get(), plan_, applied);

    // An encoder needs its output type before it accepts an input type.
    stage = "output_type";
    ComPtr<IMFMediaType> outputType;
    hr = makeOutputType(plan_, &outputType);
    if (SUCCEEDED(hr)) hr = transform->SetOutputType(outputId, outputType.Get(), 0);
    if (FAILED(hr)) {
      return false;
    }
    stage = "input_type";
    ComPtr<IMFMediaType> inputType;
    hr = makeInputType(plan_, true, &inputType);
    if (SUCCEEDED(hr)) hr = transform->SetInputType(inputId, inputType.Get(), 0);
    applied.colorSignalled = SUCCEEDED(hr);
    if (FAILED(hr)) {
      // Some drivers refuse colour attributes on the input type.
      inputType.Reset();
      hr = makeInputType(plan_, false, &inputType);
      if (SUCCEEDED(hr)) hr = transform->SetInputType(inputId, inputType.Get(), 0);
    }
    if (FAILED(hr)) {
      return false;
    }

    applyCodecSettings(codecApi.Get(), plan_, applied);

    transform_ = transform;
    codecApi_ = codecApi;
    inputId_ = inputId;
    outputId_ = outputId;
    readParameterSets();

    stage = "events";
    pump_.Attach(new EventPump(weak_from_this(), generator.Get()));
    hr = pump_->start();
    if (FAILED(hr)) {
      return false;
    }
    stage = "begin_streaming";
    hr = transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    if (FAILED(hr) && hr != E_NOTIMPL) {
      return false;
    }
    stage = "start_of_stream";
    hr = transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    if (FAILED(hr)) {
      return false;
    }
    return true;
  }

  void readParameterSets() {
    ComPtr<IMFMediaType> current;
    if (!transform_ || FAILED(transform_->GetOutputCurrentType(outputId_, &current)) || !current) {
      return;
    }
    UINT32 size = 0;
    if (FAILED(current->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size)) || size == 0) {
      return;
    }
    std::vector<uint8_t> blob(size);
    if (FAILED(current->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, blob.data(), size, &size))) {
      return;
    }
    H264ParameterSets sets;
    if (splitAnnexBParameterSets(blob.data(), size, sets)) {
      parameterSets_ = std::move(sets);
    }
  }

  void loop() {
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      wake_.wait(lock, [&] {
        return stop_ || !events_.empty() || bitratePending_ || (mailbox_.sample && credits_ > 0 && !draining_ && !failed_) ||
               (flushRequested_ && !draining_);
      });
      if (stop_) {
        return;
      }
      if (!events_.empty()) {
        ComPtr<IMFMediaEvent> event = std::move(events_.front());
        events_.pop_front();
        lock.unlock();
        handleEvent(event.Get());
        lock.lock();
        continue;
      }
      if (bitratePending_) {
        bitratePending_ = false;
        const uint32_t bitrateKbps = pendingBitrateKbps_;
        const uint32_t maxBitrateKbps = pendingMaxBitrateKbps_;
        lock.unlock();
        applyBitrate(bitrateKbps, maxBitrateKbps);
        lock.lock();
        continue;
      }
      if (mailbox_.sample && credits_ > 0 && !draining_ && !failed_) {
        Input input = std::move(mailbox_);
        mailbox_ = Input();
        --credits_;
        lock.unlock();
        submit(input);
        lock.lock();
        continue;
      }
      if (flushRequested_ && !draining_) {
        if (failed_) {
          flushRequested_ = false;
          done_.notify_all();
          continue;
        }
        // A drain resets the MFT's input requests; it asks again after the restart below.
        draining_ = true;
        credits_ = 0;
        lock.unlock();
        const HRESULT hr = transform_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
        lock.lock();
        if (FAILED(hr)) {
          draining_ = false;
          flushRequested_ = false;
          done_.notify_all();
        }
      }
    }
  }

  void handleEvent(IMFMediaEvent *event) {
    MediaEventType type = MEUnknown;
    if (FAILED(event->GetType(&type))) {
      return;
    }
    switch (type) {
      case METransformNeedInput: {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!draining_) {
          ++credits_;
        }
        break;
      }
      case METransformHaveOutput:
        processOutput();
        break;
      case METransformDrainComplete: {
        // The stream goes on after a flush: the MFT requests input again only after a new start.
        transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        forceNext_.store(true);
        {
          std::lock_guard<std::mutex> lock(mutex_);
          draining_ = false;
          flushRequested_ = false;
          ++stats_.drains;
        }
        done_.notify_all();
        break;
      }
      case MEError: {
        HRESULT status = E_FAIL;
        event->GetStatus(&status);
        fail("encoder_event", status);
        break;
      }
      default:
        break;
    }
  }

  void applyBitrate(uint32_t bitrateKbps, uint32_t maxBitrateKbps) {
    if (!codecApi_) {
      return;
    }
    if (applied_.rateControlSet) {
      applyRateControl(codecApi_.Get(), rateControlForBitrate(applied_.rateControl, bitrateKbps, maxBitrateKbps), false);
    } else {
      setCodecUInt(codecApi_.Get(), CODECAPI_AVEncCommonMeanBitRate,
                   rateControlForBitrate(RateControlMode::Cbr, bitrateKbps, maxBitrateKbps).meanBitrateBps);
    }
  }

  void countError(const char *stage, HRESULT hr) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ++stats_.errors;
    }
    if (++consecutiveErrors_ >= kMaxConsecutiveErrors) {
      fail(stage, hr);
    }
  }

  void submit(Input &input) {
    bool forced = false;
    if (input.forceKeyframe && applied_.forceKeyframe && codecApi_) {
      // Applies to the next frame the encoder receives, i.e. this one.
      forced = setCodecUInt(codecApi_.Get(), CODECAPI_AVEncVideoForceKeyFrame, 1);
    }
    timestamps_.push(input.captureNs);
    const HRESULT hr = transform_->ProcessInput(inputId_, input.sample.Get(), 0);
    if (FAILED(hr)) {
      if (input.forceKeyframe) {
        forceNext_.store(true);
      }
      if (hr == MF_E_NOTACCEPTING) {
        // The MFT took its request back; wait for the next one.
        std::lock_guard<std::mutex> lock(mutex_);
        ++stats_.dropped;
        return;
      }
      countError("process_input", hr);
      return;
    }
    consecutiveErrors_ = 0;
    std::lock_guard<std::mutex> lock(mutex_);
    ++stats_.submitted;
    if (forced) {
      ++stats_.forcedKeyframes;
    }
  }

  HRESULT createOutputSample(const MFT_OUTPUT_STREAM_INFO &info, IMFSample **out) {
    const DWORD fallbackSize = plan_.width * plan_.height * 3 / 2;
    const DWORD size = info.cbSize > 0 ? info.cbSize : fallbackSize;
    ComPtr<IMFMediaBuffer> buffer;
    HRESULT hr = info.cbAlignment > 1 ? MFCreateAlignedMemoryBuffer(size, info.cbAlignment - 1, &buffer)
                                      : MFCreateMemoryBuffer(size, &buffer);
    ComPtr<IMFSample> sample;
    if (SUCCEEDED(hr)) hr = MFCreateSample(&sample);
    if (SUCCEEDED(hr)) hr = sample->AddBuffer(buffer.Get());
    if (SUCCEEDED(hr)) *out = sample.Detach();
    return hr;
  }

  // New output type after MF_E_TRANSFORM_STREAM_CHANGE: the MFT's first H.264 offer, else ours again.
  bool renegotiateOutputType() {
    bool set = false;
    for (DWORD index = 0; !set; ++index) {
      ComPtr<IMFMediaType> type;
      if (FAILED(transform_->GetOutputAvailableType(outputId_, index, &type)) || !type) {
        break;
      }
      GUID subtype = GUID_NULL;
      if (SUCCEEDED(type->GetGUID(MF_MT_SUBTYPE, &subtype)) && subtype == MFVideoFormat_H264) {
        set = SUCCEEDED(transform_->SetOutputType(outputId_, type.Get(), 0));
      }
    }
    if (!set) {
      ComPtr<IMFMediaType> type;
      set = SUCCEEDED(makeOutputType(plan_, &type)) && SUCCEEDED(transform_->SetOutputType(outputId_, type.Get(), 0));
    }
    if (set) {
      readParameterSets();
      std::lock_guard<std::mutex> lock(mutex_);
      ++stats_.streamChanges;
    }
    return set;
  }

  void processOutput() {
    MFT_OUTPUT_STREAM_INFO streamInfo = {};
    const HRESULT infoHr = transform_->GetOutputStreamInfo(outputId_, &streamInfo);
    const bool mftAllocates =
        SUCCEEDED(infoHr) &&
        (streamInfo.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
    for (int attempt = 0; attempt < 2; ++attempt) {
      MFT_OUTPUT_DATA_BUFFER output = {};
      output.dwStreamID = outputId_;
      ComPtr<IMFSample> sample;
      if (!mftAllocates) {
        const HRESULT hr = createOutputSample(streamInfo, &sample);
        if (FAILED(hr)) {
          countError("output_sample", hr);
          return;
        }
        output.pSample = sample.Get();
      }
      DWORD status = 0;
      const HRESULT hr = transform_->ProcessOutput(0, 1, &output, &status);
      if (mftAllocates) {
        sample.Attach(output.pSample);
      }
      if (output.pEvents != nullptr) {
        output.pEvents->Release();
      }
      if (hr == MF_E_TRANSFORM_STREAM_CHANGE && attempt == 0) {
        if (renegotiateOutputType()) {
          continue;
        }
        countError("stream_change", hr);
        return;
      }
      if (FAILED(hr)) {
        // After a renegotiation the MFT may announce the output again instead of keeping it ready.
        if (hr != MF_E_TRANSFORM_NEED_MORE_INPUT && attempt == 0) {
          countError("process_output", hr);
        }
        return;
      }
      consecutiveErrors_ = 0;
      if (sample) {
        deliver(sample.Get());
      }
      return;
    }
  }

  void deliver(IMFSample *sample) {
    EncodedAccessUnit unit;
    {
      ComPtr<IMFMediaBuffer> buffer;
      if (FAILED(sample->ConvertToContiguousBuffer(&buffer)) || !buffer) {
        return;
      }
      BYTE *data = nullptr;
      DWORD length = 0;
      if (FAILED(buffer->Lock(&data, nullptr, &length))) {
        return;
      }
      if (data != nullptr && length > 0) {
        unit.annexB.assign(data, data + length);
      }
      buffer->Unlock();
    }
    LONGLONG sampleTime = -1;
    if (FAILED(sample->GetSampleTime(&sampleTime))) {
      sampleTime = -1;
    }
    unit.captureNs = timestamps_.take(sampleTime);
    // MFVideoFormat_H264 is Annex B by definition; anything else is not passed on.
    if (unit.annexB.empty() || firstNalType(unit.annexB) < 0) {
      std::lock_guard<std::mutex> lock(mutex_);
      ++stats_.errors;
      return;
    }
    unit.keyframe = containsIdr(unit.annexB);
    if (unit.keyframe && !containsNalType(unit.annexB, 7)) {
      // Late joiners need SPS/PPS in front of every IDR; not every MFT repeats them in-band.
      if (parameterSets_.sps.empty()) {
        readParameterSets();
      }
      if (!parameterSets_.sps.empty()) {
        prependParameterSets(parameterSets_, unit.annexB);
      }
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ++stats_.encoded;
    }
    std::lock_guard<std::mutex> lock(ownerMutex_);
    if (owner_ != nullptr && owner_->onAccessUnit) {
      owner_->onAccessUnit(std::move(unit));
    }
  }

  void close() {
    if (pump_) {
      pump_->detach();
      pump_.Reset();
    }
    if (transform_) {
      transform_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
      shutdownTransform(transform_.Get());
    }
    codecApi_.Reset();
    transform_.Reset();
    if (candidateShutdown_) {
      candidateShutdown_();
      candidateShutdown_ = nullptr;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      mailbox_ = Input();
      events_.clear();
    }
    // Media Foundation objects must be gone before MFShutdown.
    std::lock_guard<std::mutex> lock(inputMutex_);
    inputClosed_ = true;
    pool_.clear();
  }

  // --- capture thread -------------------------------------------------------

  // Always a copy into one of the encoder's own samples. The frame is only
  // borrowed for this call while the MFT keeps its input until it has encoded
  // it, so a capturer's sample (CapturedFrame::nativeHandle) is never handed
  // on: that would need the sample kept alive for the MFT and its buffer
  // checked (system memory, one contiguous NV12 frame), and no source needs it.
  bool buildInputSample(const CapturedFrame &frame, ComPtr<IMFSample> &out) {
    std::lock_guard<std::mutex> lock(inputMutex_);
    if (inputClosed_) {
      return false;
    }
    if (frame.planeCount == 0) {
      return false;
    }
    PooledSample *slot = acquirePooledSample();
    if (slot == nullptr) {
      return false;
    }
    BYTE *data = nullptr;
    if (FAILED(slot->buffer->Lock(&data, nullptr, nullptr)) || data == nullptr) {
      return false;
    }
    // Contiguous NV12 at the default stride (plan sizes are even).
    const size_t lumaSize = static_cast<size_t>(plan_.width) * plan_.height;
    const Nv12Planes planes{data, plan_.width, data + lumaSize, plan_.width};
    const bool converted = frameToNv12(frame, planes, plan_.width, plan_.height, scratch_);
    slot->buffer->Unlock();
    if (!converted) {
      return false;
    }
    slot->buffer->SetCurrentLength(static_cast<DWORD>(lumaSize + lumaSize / 2));
    out = slot->sample;
    return true;
  }

  // A pooled sample is free again once only the pool refers to it (the MFT released its input).
  PooledSample *acquirePooledSample() {
    for (PooledSample &slot : pool_) {
      if (refCount(slot.sample.Get()) == slot.idleSampleRefs && refCount(slot.buffer.Get()) == slot.idleBufferRefs) {
        return &slot;
      }
    }
    if (pool_.size() >= kInputPoolSize) {
      return nullptr;
    }
    const DWORD size = plan_.width * plan_.height * 3 / 2;
    PooledSample slot;
    if (FAILED(MFCreateMemoryBuffer(size, &slot.buffer)) || FAILED(MFCreateSample(&slot.sample)) ||
        FAILED(slot.sample->AddBuffer(slot.buffer.Get()))) {
      return nullptr;
    }
    slot.idleSampleRefs = refCount(slot.sample.Get());
    slot.idleBufferRefs = refCount(slot.buffer.Get());
    pool_.push_back(std::move(slot));
    return &pool_.back();
  }

  const MfEncoderEnumerator enumerator_;
  const EncoderVendor preferred_;
  const EncoderAttributePlan plan_;

  std::mutex mutex_;
  std::condition_variable wake_;  // encoder thread
  std::condition_variable done_;  // configure / flush / teardown waiters
  bool stop_ = false;
  bool openFinished_ = false;
  bool opened_ = false;
  bool exited_ = false;
  bool failed_ = false;
  std::string error_;
  EncoderInfo info_;
  std::deque<ComPtr<IMFMediaEvent>> events_;
  Input mailbox_;
  uint32_t credits_ = 0;
  bool draining_ = false;
  bool flushRequested_ = false;
  bool bitratePending_ = false;
  uint32_t pendingBitrateKbps_ = 0;
  uint32_t pendingMaxBitrateKbps_ = 0;
  MfEncoderStats stats_;
  std::atomic<bool> forceNext_{false};

  // Guards the callback into the encoder object against its destruction.
  std::mutex ownerMutex_;
  VideoEncoder *owner_ = nullptr;

  // Capture thread.
  std::mutex inputMutex_;
  bool inputClosed_ = false;
  std::deque<PooledSample> pool_;
  std::vector<uint8_t> scratch_;

  // Encoder thread only.
  ComPtr<IMFTransform> transform_;
  ComPtr<ICodecAPI> codecApi_;
  ComPtr<EventPump> pump_;
  std::function<void()> candidateShutdown_;
  DWORD inputId_ = 0;
  DWORD outputId_ = 0;
  AppliedSettings applied_;
  H264ParameterSets parameterSets_;
  CaptureTimestampMap timestamps_;
  uint32_t consecutiveErrors_ = 0;
};

STDMETHODIMP EventPump::Invoke(IMFAsyncResult *result) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::shared_ptr<Session> session = session_.lock();
  if (!generator_ || !session) {
    return S_OK;
  }
  ComPtr<IMFMediaEvent> event;
  HRESULT hr = generator_->EndGetEvent(result, &event);
  if (SUCCEEDED(hr) && event) {
    session->pushEvent(std::move(event));
    hr = generator_->BeginGetEvent(this, nullptr);
  }
  if (FAILED(hr)) {
    session->eventFailure(hr);
  }
  return S_OK;
}

class MediaFoundationEncoder final : public VideoEncoder {
 public:
  MediaFoundationEncoder(MfEncoderEnumerator enumerator, EncoderVendor preferred)
      : enumerator_(std::move(enumerator)), preferred_(preferred) {}
  ~MediaFoundationEncoder() override { teardown(); }

  bool configure(const EncodeTarget &target, std::string &errorCode, std::string &error) override {
    teardown();
    auto session = std::make_shared<Session>(enumerator_, preferred_, planEncoderAttributes(target), this);
    std::thread thread([session] { session->run(); });
    EncoderInfo info;
    if (!session->waitOpened(error, info)) {
      errorCode = "encoder_unavailable";
      stopSession(session, thread);
      return false;
    }
    // Like the VideoToolbox encoder: the stream opens on an IDR.
    session->requestKeyframe();
    std::lock_guard<std::mutex> lock(mutex_);
    session_ = std::move(session);
    thread_ = std::move(thread);
    info_ = std::move(info);
    return true;
  }

  bool encode(const CapturedFrame &frame, bool forceKeyframe) override {
    const std::shared_ptr<Session> session = current();
    return session && session->enqueue(frame, forceKeyframe);
  }

  void setBitrate(uint32_t bitrateKbps, uint32_t maxBitrateKbps) override {
    if (const std::shared_ptr<Session> session = current()) {
      session->setBitrate(bitrateKbps, maxBitrateKbps);
    }
  }

  void requestKeyframe() override {
    if (const std::shared_ptr<Session> session = current()) {
      session->requestKeyframe();
    }
  }

  void flush() override {
    if (const std::shared_ptr<Session> session = current()) {
      session->flush();
    }
  }

  EncoderInfo info() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (info_.backend.empty()) {
      EncoderInfo info;
      info.backend = "mediafoundation";
      info.hardware = true;
      return info;
    }
    return info_;
  }

  MfEncoderStats stats() const {
    const std::shared_ptr<Session> session = current();
    return session ? session->stats() : MfEncoderStats();
  }

 private:
  std::shared_ptr<Session> current() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return session_;
  }

  static void stopSession(const std::shared_ptr<Session> &session, std::thread &thread) {
    if (session->stop()) {
      thread.join();
      return;
    }
    // A driver call does not return: leave the thread (it owns the session) instead of hanging the helper.
    thread.detach();
    broadify::helper::emitHelperEvent("{\"type\":\"mf_encoder_error\",\"stage\":\"teardown_timeout\"}");
  }

  void teardown() {
    std::shared_ptr<Session> session;
    std::thread thread;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      session = std::move(session_);
      session_.reset();
      thread = std::move(thread_);
    }
    if (session) {
      stopSession(session, thread);
    }
  }

  const MfEncoderEnumerator enumerator_;
  const EncoderVendor preferred_;
  mutable std::mutex mutex_;
  std::shared_ptr<Session> session_;
  std::thread thread_;
  EncoderInfo info_;
};

}  // namespace

HRESULT enumerateHardwareH264Encoders(std::vector<MfEncoderCandidate> &candidates) {
  MFT_REGISTER_TYPE_INFO inputType = {MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO outputType = {MFMediaType_Video, MFVideoFormat_H264};
  IMFActivate **activates = nullptr;
  UINT32 count = 0;
  const HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                               &inputType, &outputType, &activates, &count);
  if (FAILED(hr)) {
    return hr;
  }
  for (UINT32 index = 0; index < count; ++index) {
    ComPtr<IMFActivate> activate;
    activate.Attach(activates[index]);
    if (!activate) {
      continue;
    }
    MfEncoderCandidate candidate;
    wchar_t *text = nullptr;
    UINT32 length = 0;
    if (SUCCEEDED(activate->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &text, &length))) {
      candidate.name = narrow(text);
      CoTaskMemFree(text);
    }
    text = nullptr;
    if (SUCCEEDED(activate->GetAllocatedString(MFT_ENUM_HARDWARE_VENDOR_ID_Attribute, &text, &length))) {
      candidate.vendorId = narrow(text);
      CoTaskMemFree(text);
    }
    candidate.hardware = true;
    candidate.activate = [activate](IMFTransform **transform) {
      return activate->ActivateObject(IID_PPV_ARGS(transform));
    };
    candidate.shutdown = [activate] { activate->ShutdownObject(); };
    candidates.push_back(std::move(candidate));
  }
  CoTaskMemFree(activates);
  return S_OK;
}

std::unique_ptr<VideoEncoder> createMediaFoundationEncoder(MfEncoderEnumerator enumerator,
                                                           const std::string &preferredVendor) {
  return std::make_unique<MediaFoundationEncoder>(std::move(enumerator), parseEncoderVendor(preferredVendor));
}

MfEncoderStats mediaFoundationEncoderStats(const VideoEncoder &encoder) {
  const auto *mf = dynamic_cast<const MediaFoundationEncoder *>(&encoder);
  return mf != nullptr ? mf->stats() : MfEncoderStats();
}

std::unique_ptr<VideoEncoder> createHardwareEncoder() {
  // BRIDGE_PGM_ENCODER_VENDOR=nvidia|intel|amd prefers that vendor's hardware encoder (device tests on hybrid GPUs).
  const char *vendor = std::getenv("BRIDGE_PGM_ENCODER_VENDOR");
  return createMediaFoundationEncoder(&enumerateHardwareH264Encoders, vendor != nullptr ? vendor : "");
}

}  // namespace broadify::live

#endif  // _WIN32
