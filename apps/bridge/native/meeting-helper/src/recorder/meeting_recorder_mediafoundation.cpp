#include "recorder/meeting_recorder.h"

// Windows Media Foundation recorder. Mirrors the macOS AVAssetWriter
// implementation in meeting_recorder.mm: composited program frames (RGBA8)
// plus one microphone are written to an .mp4 (H.264 + AAC). Video and audio
// are timestamped on the shared MF system clock (QPC) so they stay in sync.
// All public methods are thread-safe: start/stop run on the control thread,
// appendVideoFrame on the pipeline thread, audio capture on its own thread.

#include <windows.h>

#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace broadify::meeting {

namespace {

constexpr uint64_t kHnsPerSecond = 10'000'000ull;

double secondsSince(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - start)
      .count();
}

// Per-thread COM apartment (same idiom as camera_mediafoundation.cpp).
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

std::string wideToUtf8(const wchar_t *wide) {
  if (wide == nullptr) {
    return {};
  }
  const int needed =
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  if (needed <= 1) {
    return {};
  }
  std::string out(static_cast<size_t>(needed - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), needed, nullptr,
                      nullptr);
  return out;
}

std::wstring utf8ToWide(const std::string &utf8) {
  if (utf8.empty()) {
    return {};
  }
  const int needed =
      MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  if (needed <= 1) {
    return {};
  }
  std::wstring out(static_cast<size_t>(needed - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, out.data(), needed);
  return out;
}

std::string hresultError(const char *what, HRESULT hr) {
  char buffer[128];
  snprintf(buffer, sizeof(buffer), "%s (hr=0x%08lX)", what,
           static_cast<unsigned long>(hr));
  return buffer;
}

// Default capture endpoint id ("" on error) for marking the default mic.
std::wstring defaultCaptureEndpointId() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                              CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) {
    return {};
  }
  ComPtr<IMMDevice> device;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole,
                                                 &device))) {
    return {};
  }
  wchar_t *id = nullptr;
  if (FAILED(device->GetId(&id)) || id == nullptr) {
    return {};
  }
  std::wstring result(id);
  CoTaskMemFree(id);
  return result;
}

struct AudioFormat {
  uint32_t sampleRate = 48000;
  uint32_t channels = 1;
};

}  // namespace

struct MeetingRecorder::Impl {
  mutable std::mutex mutex;

  bool active = false;
  std::string filePath;
  std::string lastError;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 30;
  uint64_t videoFrames = 0;
  std::chrono::steady_clock::time_point startedAt;

  bool mfStarted = false;

  ComPtr<IMFSinkWriter> writer;
  DWORD videoStream = 0;
  DWORD audioStream = 0;
  // MF system time (QPC-based, 100ns) when the writing session started.
  // Both video and audio timestamps are rebased against this.
  LONGLONG sessionStartHns = 0;

  ComPtr<IMFMediaSource> micSource;
  ComPtr<IMFSourceReader> micReader;
  ComPtr<IUnknown> micCallback;  // keeps the callback alive with the reader
  std::atomic<bool> audioRunning{false};
  // Signaled by the callback once it stops re-requesting samples, so stop()
  // can wait (bounded) for the async pump to drain before finalizing.
  HANDLE audioDrained = nullptr;
};

namespace {

// Async microphone pump: every completed read appends the sample to the sink
// writer (drops samples captured before the session start, mirroring the
// macOS delegate) and immediately requests the next one. A synchronous
// ReadSample loop is NOT usable here: devices that never deliver samples
// (e.g. idle virtual NDI audio) would block the read forever and deadlock
// stop() on the thread join.
class MicReaderCallback : public IMFSourceReaderCallback {
 public:
  explicit MicReaderCallback(MeetingRecorder::Impl *impl) : impl_(impl) {}

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IMFSourceReaderCallback)) {
      *ppv = static_cast<IMFSourceReaderCallback *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refCount_; }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG count = --refCount_;
    if (count == 0) {
      delete this;
    }
    return count;
  }

  // IMFSourceReaderCallback
  STDMETHODIMP OnReadSample(HRESULT hrStatus, DWORD /*streamIndex*/,
                            DWORD streamFlags, LONGLONG timestampHns,
                            IMFSample *sample) override {
    ComPtr<IMFSourceReader> reader;
    ComPtr<IMFSinkWriter> writer;
    DWORD audioStream = 0;
    LONGLONG sessionStartHns = 0;
    bool running = false;
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      reader = impl_->micReader;
      writer = impl_->writer;
      audioStream = impl_->audioStream;
      sessionStartHns = impl_->sessionStartHns;
      running = impl_->audioRunning.load();
    }

    const bool ended = FAILED(hrStatus) ||
                       (streamFlags & MF_SOURCE_READERF_ENDOFSTREAM) != 0;
    if (!running || ended || !reader || !writer) {
      if (FAILED(hrStatus)) {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        if (impl_->lastError.empty()) {
          impl_->lastError = hresultError("audio_read_failed", hrStatus);
        }
      }
      signalDrained();
      return S_OK;
    }

    if (sample != nullptr && timestampHns >= sessionStartHns) {
      sample->SetSampleTime(timestampHns - sessionStartHns);
      writer->WriteSample(audioStream, sample);
    }

    const HRESULT next = reader->ReadSample(
        static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), 0, nullptr,
        nullptr, nullptr, nullptr);
    if (FAILED(next)) {
      signalDrained();
    }
    return S_OK;
  }
  STDMETHODIMP OnFlush(DWORD) override {
    signalDrained();
    return S_OK;
  }
  STDMETHODIMP OnEvent(DWORD, IMFMediaEvent *) override { return S_OK; }

 private:
  ~MicReaderCallback() = default;

  void signalDrained() {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->audioDrained != nullptr) {
      SetEvent(impl_->audioDrained);
    }
  }

  MeetingRecorder::Impl *impl_;
  std::atomic<ULONG> refCount_{1};
};

// Try the preferred PCM output formats on the mic reader; the source reader
// inserts converters/resamplers as needed. Returns the accepted format.
bool configureMicPcmOutput(IMFSourceReader *reader, AudioFormat *accepted) {
  const AudioFormat candidates[] = {
      {48000, 1}, {48000, 2}, {44100, 1}, {44100, 2}};
  for (const AudioFormat &candidate : candidates) {
    ComPtr<IMFMediaType> pcm;
    if (FAILED(MFCreateMediaType(&pcm))) {
      return false;
    }
    pcm->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    pcm->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    pcm->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, candidate.sampleRate);
    pcm->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, candidate.channels);
    pcm->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    pcm->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, candidate.channels * 2);
    pcm->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                   candidate.sampleRate * candidate.channels * 2);
    if (SUCCEEDED(reader->SetCurrentMediaType(
            static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), nullptr,
            pcm.Get()))) {
      *accepted = candidate;
      return true;
    }
  }
  return false;
}

}  // namespace

MeetingRecorder::MeetingRecorder() : impl_(new Impl()) {
  ComApartment com;
  impl_->mfStarted = SUCCEEDED(MFStartup(MF_VERSION));
}

MeetingRecorder::~MeetingRecorder() {
  stop();
  if (impl_->mfStarted) {
    MFShutdown();
  }
  delete impl_;
}

std::vector<MicrophoneInfo> MeetingRecorder::listMicrophones() const {
  std::vector<MicrophoneInfo> result;
  ComApartment com;

  ComPtr<IMFAttributes> attributes;
  if (FAILED(MFCreateAttributes(&attributes, 1))) {
    return result;
  }
  attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID);

  IMFActivate **devices = nullptr;
  UINT32 count = 0;
  if (FAILED(MFEnumDeviceSources(attributes.Get(), &devices, &count))) {
    return result;
  }

  const std::wstring defaultId = defaultCaptureEndpointId();
  for (UINT32 i = 0; i < count; i++) {
    MicrophoneInfo info;
    wchar_t *endpointId = nullptr;
    UINT32 idLength = 0;
    if (SUCCEEDED(devices[i]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_ENDPOINT_ID, &endpointId,
            &idLength))) {
      info.deviceId = wideToUtf8(endpointId);
      info.isDefault = !defaultId.empty() && defaultId == endpointId;
      CoTaskMemFree(endpointId);
    }
    wchar_t *friendlyName = nullptr;
    UINT32 nameLength = 0;
    if (SUCCEEDED(devices[i]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &friendlyName,
            &nameLength))) {
      info.label = wideToUtf8(friendlyName);
      CoTaskMemFree(friendlyName);
    }
    if (info.label.empty()) {
      info.label = info.deviceId;
    }
    if (!info.deviceId.empty()) {
      result.push_back(std::move(info));
    }
    devices[i]->Release();
  }
  CoTaskMemFree(devices);
  return result;
}

bool MeetingRecorder::start(const std::string &filePath,
                            const std::string &micDeviceId, uint32_t width,
                            uint32_t height, uint32_t fps) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->active) {
    impl_->lastError = "already_recording";
    return false;
  }
  if (width == 0 || height == 0 || filePath.empty()) {
    impl_->lastError = "invalid_arguments";
    return false;
  }

  ComApartment com;
  const uint32_t safeFps = fps > 0 ? fps : 30;

  const std::wstring widePath = utf8ToWide(filePath);
  if (widePath.empty()) {
    impl_->lastError = "invalid_arguments";
    return false;
  }
  DeleteFileW(widePath.c_str());

  // --- Microphone source first: its failure modes (permission, missing
  // device) should not leave a half-created output file behind.
  ComPtr<IMFAttributes> deviceAttributes;
  HRESULT hr = MFCreateAttributes(&deviceAttributes, 2);
  if (SUCCEEDED(hr)) {
    hr = deviceAttributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                                   MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID);
  }
  std::wstring endpointId = utf8ToWide(micDeviceId);
  if (endpointId.empty()) {
    endpointId = defaultCaptureEndpointId();
  }
  if (SUCCEEDED(hr) && !endpointId.empty()) {
    hr = deviceAttributes->SetString(
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_ENDPOINT_ID,
        endpointId.c_str());
  }
  ComPtr<IMFMediaSource> micSource;
  if (SUCCEEDED(hr)) {
    hr = MFCreateDeviceSource(deviceAttributes.Get(), &micSource);
  }
  if (FAILED(hr)) {
    impl_->lastError = (hr == E_ACCESSDENIED ||
                        hr == HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED))
                           ? "microphone_permission_denied"
                           : hresultError("microphone_not_found", hr);
    return false;
  }

  ComPtr<IUnknown> callback;
  callback.Attach(static_cast<IMFSourceReaderCallback *>(
      new MicReaderCallback(impl_)));
  ComPtr<IMFAttributes> readerAttributes;
  hr = MFCreateAttributes(&readerAttributes, 1);
  if (SUCCEEDED(hr)) {
    hr = readerAttributes->SetUnknown(MF_SOURCE_READER_ASYNC_CALLBACK,
                                      callback.Get());
  }
  ComPtr<IMFSourceReader> micReader;
  if (SUCCEEDED(hr)) {
    hr = MFCreateSourceReaderFromMediaSource(
        micSource.Get(), readerAttributes.Get(), &micReader);
  }
  if (FAILED(hr)) {
    micSource->Shutdown();
    impl_->lastError = hresultError("microphone_input_failed", hr);
    return false;
  }
  AudioFormat audioFormat;
  if (!configureMicPcmOutput(micReader.Get(), &audioFormat)) {
    micSource->Shutdown();
    impl_->lastError = "microphone_format_unsupported";
    return false;
  }

  // --- Sink writer (MP4 container from the .mp4 extension).
  ComPtr<IMFAttributes> writerAttributes;
  MFCreateAttributes(&writerAttributes, 2);
  if (writerAttributes) {
    writerAttributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
    writerAttributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE);
  }
  ComPtr<IMFSinkWriter> writer;
  hr = MFCreateSinkWriterFromURL(widePath.c_str(), nullptr,
                                 writerAttributes.Get(), &writer);
  if (FAILED(hr)) {
    micSource->Shutdown();
    impl_->lastError = hresultError("writer_create_failed", hr);
    return false;
  }

  // Video output: H.264 at ~0.2 bits/pixel (visually clean for screen+camera
  // content), clamped so 4K never balloons — same policy as the macOS path.
  const uint64_t pixels = static_cast<uint64_t>(width) * height;
  uint64_t bitrate = pixels * safeFps / 5;  // 0.2 bpp
  if (bitrate > 24000000ull) {
    bitrate = 24000000ull;
  }
  if (bitrate < 2000000ull) {
    bitrate = 2000000ull;
  }

  ComPtr<IMFMediaType> videoOut;
  MFCreateMediaType(&videoOut);
  videoOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  videoOut->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  videoOut->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrate));
  videoOut->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  videoOut->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
  MFSetAttributeSize(videoOut.Get(), MF_MT_FRAME_SIZE, width, height);
  MFSetAttributeRatio(videoOut.Get(), MF_MT_FRAME_RATE, safeFps, 1);
  MFSetAttributeRatio(videoOut.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  DWORD videoStream = 0;
  hr = writer->AddStream(videoOut.Get(), &videoStream);
  if (FAILED(hr)) {
    micSource->Shutdown();
    impl_->lastError = hresultError("video_input_rejected", hr);
    return false;
  }

  // Video input: top-down BGRA (positive default stride); the sink writer
  // inserts the H.264 encoder and any needed color converter.
  ComPtr<IMFMediaType> videoIn;
  MFCreateMediaType(&videoIn);
  videoIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  videoIn->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
  videoIn->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  videoIn->SetUINT32(MF_MT_DEFAULT_STRIDE, width * 4u);
  MFSetAttributeSize(videoIn.Get(), MF_MT_FRAME_SIZE, width, height);
  MFSetAttributeRatio(videoIn.Get(), MF_MT_FRAME_RATE, safeFps, 1);
  MFSetAttributeRatio(videoIn.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  hr = writer->SetInputMediaType(videoStream, videoIn.Get(), nullptr);
  if (FAILED(hr)) {
    micSource->Shutdown();
    impl_->lastError = hresultError("video_input_rejected", hr);
    return false;
  }

  // Audio output: AAC 128kbit at the negotiated PCM rate/channels.
  ComPtr<IMFMediaType> audioOut;
  MFCreateMediaType(&audioOut);
  audioOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
  audioOut->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
  audioOut->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, audioFormat.sampleRate);
  audioOut->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, audioFormat.channels);
  audioOut->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
  audioOut->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 16000);  // 128 kbit/s
  DWORD audioStream = 0;
  hr = writer->AddStream(audioOut.Get(), &audioStream);
  if (FAILED(hr)) {
    micSource->Shutdown();
    impl_->lastError = hresultError("audio_input_rejected", hr);
    return false;
  }
  ComPtr<IMFMediaType> audioIn;
  MFCreateMediaType(&audioIn);
  audioIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
  audioIn->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
  audioIn->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, audioFormat.sampleRate);
  audioIn->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, audioFormat.channels);
  audioIn->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
  audioIn->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, audioFormat.channels * 2);
  audioIn->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                     audioFormat.sampleRate * audioFormat.channels * 2);
  hr = writer->SetInputMediaType(audioStream, audioIn.Get(), nullptr);
  if (FAILED(hr)) {
    micSource->Shutdown();
    impl_->lastError = hresultError("audio_input_rejected", hr);
    return false;
  }

  hr = writer->BeginWriting();
  if (FAILED(hr)) {
    micSource->Shutdown();
    impl_->lastError = hresultError("start_writing_failed", hr);
    return false;
  }

  // Prime the audio stream with 10ms of silence at t=0. A capture device
  // that never delivers (e.g. an idle virtual NDI audio endpoint) would
  // otherwise leave the AAC stream empty, which wedges the MP4 sink's
  // Finalize.
  {
    const uint32_t silentBytes =
        audioFormat.sampleRate / 100u * audioFormat.channels * 2u;
    ComPtr<IMFMediaBuffer> silentBuffer;
    if (SUCCEEDED(MFCreateMemoryBuffer(silentBytes, &silentBuffer))) {
      BYTE *data = nullptr;
      if (SUCCEEDED(silentBuffer->Lock(&data, nullptr, nullptr))) {
        memset(data, 0, silentBytes);
        silentBuffer->Unlock();
        silentBuffer->SetCurrentLength(silentBytes);
        ComPtr<IMFSample> silentSample;
        if (SUCCEEDED(MFCreateSample(&silentSample))) {
          silentSample->AddBuffer(silentBuffer.Get());
          silentSample->SetSampleTime(0);
          silentSample->SetSampleDuration(kHnsPerSecond / 100);
          writer->WriteSample(audioStream, silentSample.Get());
        }
      }
    }
  }

  impl_->writer = writer;
  impl_->videoStream = videoStream;
  impl_->audioStream = audioStream;
  impl_->sessionStartHns = MFGetSystemTime();
  impl_->micSource = micSource;
  impl_->micReader = micReader;
  impl_->micCallback = callback;
  impl_->audioDrained = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  impl_->filePath = filePath;
  impl_->width = width;
  impl_->height = height;
  impl_->fps = safeFps;
  impl_->videoFrames = 0;
  impl_->startedAt = std::chrono::steady_clock::now();
  impl_->lastError.clear();
  impl_->active = true;
  impl_->audioRunning.store(true);

  // Kick off the async pump; the callback keeps re-requesting samples.
  hr = micReader->ReadSample(
      static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), 0, nullptr,
      nullptr, nullptr, nullptr);
  if (FAILED(hr) && impl_->audioDrained != nullptr) {
    SetEvent(impl_->audioDrained);  // nothing in flight to wait for
  }
  return true;
}

void MeetingRecorder::appendVideoFrame(const uint8_t *rgba, uint32_t width,
                                       uint32_t height) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!impl_->active || rgba == nullptr || !impl_->writer) {
    return;
  }
  if (width != impl_->width || height != impl_->height) {
    return;  // geometry changed mid-recording; skip until it matches
  }

  const size_t frameBytes = static_cast<size_t>(width) * height * 4u;
  ComPtr<IMFMediaBuffer> buffer;
  if (FAILED(MFCreateMemoryBuffer(static_cast<DWORD>(frameBytes), &buffer))) {
    return;
  }
  BYTE *dst = nullptr;
  if (FAILED(buffer->Lock(&dst, nullptr, nullptr))) {
    return;
  }
  // RGBA8 -> BGRA8 (RGB32 is B,G,R,X in memory): swap R and B.
  const size_t pixelCount = static_cast<size_t>(width) * height;
  for (size_t i = 0; i < pixelCount; i++) {
    const uint8_t *src = rgba + i * 4u;
    BYTE *out = dst + i * 4u;
    out[0] = src[2];
    out[1] = src[1];
    out[2] = src[0];
    out[3] = 255;
  }
  buffer->Unlock();
  buffer->SetCurrentLength(static_cast<DWORD>(frameBytes));

  ComPtr<IMFSample> sample;
  if (FAILED(MFCreateSample(&sample))) {
    return;
  }
  sample->AddBuffer(buffer.Get());
  sample->SetSampleTime(MFGetSystemTime() - impl_->sessionStartHns);
  sample->SetSampleDuration(
      static_cast<LONGLONG>(kHnsPerSecond / impl_->fps));
  if (SUCCEEDED(impl_->writer->WriteSample(impl_->videoStream, sample.Get()))) {
    ++impl_->videoFrames;
  }
}

void MeetingRecorder::stop() {
  ComPtr<IMFSinkWriter> writer;
  ComPtr<IMFSourceReader> micReader;
  ComPtr<IMFMediaSource> micSource;
  ComPtr<IUnknown> micCallback;
  HANDLE drained = nullptr;
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (!impl_->active) {
      return;
    }
    impl_->active = false;
    impl_->audioRunning.store(false);
    writer = impl_->writer;
    micReader = impl_->micReader;
    micSource = impl_->micSource;
    micCallback = impl_->micCallback;
    drained = impl_->audioDrained;
    // Drop impl's references now; the detached teardown thread below holds
    // the survivors. signalDrained() guards on the nulled event separately.
    impl_->writer = nullptr;
    impl_->micReader = nullptr;
    impl_->micSource = nullptr;
    impl_->micCallback = nullptr;
    impl_->sessionStartHns = 0;
  }

  ComApartment com;
  // Give an in-flight audio callback time to return before finalizing (the
  // callback stops writing the moment audioRunning clears).
  if (drained != nullptr) {
    WaitForSingleObject(drained, 1500);
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->audioDrained = nullptr;
    CloseHandle(drained);
  }

  // Never block the control thread on the capture graph: a wedged virtual
  // device (e.g. an idle NDI webcam audio endpoint) hangs Flush, Shutdown AND
  // the source reader's final Release (it waits for the pending ReadSample),
  // so the whole capture teardown runs on a detached thread that holds the
  // last references.
  if (micSource || micReader) {
    std::thread([source = std::move(micSource), reader = std::move(micReader),
                 callback = std::move(micCallback)]() mutable {
      ComApartment threadCom;
      if (source) {
        source->Shutdown();
      }
      reader.Reset();
      source.Reset();
      callback.Reset();
    }).detach();
  }

  if (writer) {
    const HRESULT hr = writer->Finalize();
    if (FAILED(hr)) {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      impl_->lastError = hresultError("finish_failed", hr);
    }
  }
}

RecordingStatus MeetingRecorder::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  RecordingStatus status;
  status.active = impl_->active;
  status.filePath = impl_->filePath;
  status.videoFrames = impl_->videoFrames;
  status.elapsedSeconds = impl_->active ? secondsSince(impl_->startedAt) : 0.0;
  status.lastError = impl_->lastError;
  return status;
}

}  // namespace broadify::meeting
