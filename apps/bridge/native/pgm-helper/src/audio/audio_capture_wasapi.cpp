// Windows audio backend of the PGM helper (ADR-0009): WASAPI capture in shared
// mode, event driven, the counterpart of audio_capture_avfoundation.mm. The
// endpoint is the one that belongs to the selected video device (same device
// container, else the name rule; audio/audio_pairing.h), never the default
// microphone. The audio engine converts to 48 kHz stereo float for us
// (AUTOCONVERTPCM), so other applications keep using the device.

#if defined(_WIN32)

#include "audio/audio_pairing.h"
#include "audio/audio_source.h"

#include "helper_common/helper_event_log.h"
#include "helper_common/json_utils.h"
#include "helper_common/path_utf8.h"
#include "live_stream/monotonic_clock.h"

#include <windows.h>

#include <objbase.h>

#include <audioclient.h>
#include <avrt.h>
#include <cfgmgr32.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <propidl.h>
#include <wrl/client.h>

// Instantiates the property keys of the two headers below in this translation unit.
#include <initguid.h>

#include <devpkey.h>
#include <functiondiscoverykeys_devpkey.h>

#include <atomic>
#include <cstdint>
#include <iterator>
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
using broadify::helper::wideToUtf8;

constexpr DWORD kSampleRate = 48000;
constexpr WORD kChannels = 2;
// Endpoint buffer the audio engine keeps for us (100 ns units): 200 ms.
constexpr REFERENCE_TIME kBufferDuration = 2'000'000;
// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT (ksmedia.h), spelled out so this file needs no kernel streaming headers.
const GUID kSubtypeIeeeFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

std::string hresultHex(HRESULT hr) {
  std::ostringstream out;
  out << "0x" << std::hex << std::uppercase << static_cast<uint32_t>(hr);
  return out.str();
}

std::string guidString(const GUID &guid) {
  wchar_t buffer[64] = {};
  if (StringFromGUID2(guid, buffer, static_cast<int>(std::size(buffer))) <= 0) {
    return "";
  }
  return wideToUtf8(buffer);
}

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

std::string stringProperty(IPropertyStore *store, const PROPERTYKEY &key) {
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string text;
  if (SUCCEEDED(store->GetValue(key, &value)) && value.vt == VT_LPWSTR && value.pwszVal != nullptr) {
    text = wideToUtf8(value.pwszVal);
  }
  PropVariantClear(&value);
  return text;
}

std::string guidProperty(IPropertyStore *store, const PROPERTYKEY &key) {
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string text;
  if (SUCCEEDED(store->GetValue(key, &value)) && value.vt == VT_CLSID && value.puuid != nullptr) {
    text = guidString(*value.puuid);
  }
  PropVariantClear(&value);
  return text;
}

struct Endpoint {
  std::wstring id;
  AudioEndpointCandidate candidate;
};

// Active capture endpoints. Requires COM on the caller.
std::vector<Endpoint> captureEndpoints() {
  std::vector<Endpoint> endpoints;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) {
    return endpoints;
  }
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection))) {
    return endpoints;
  }
  UINT count = 0;
  collection->GetCount(&count);
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(index, &device))) {
      continue;
    }
    LPWSTR id = nullptr;
    if (FAILED(device->GetId(&id)) || id == nullptr) {
      continue;
    }
    Endpoint endpoint;
    endpoint.id = id;
    endpoint.candidate.id = wideToUtf8(id);
    CoTaskMemFree(id);
    ComPtr<IPropertyStore> store;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store))) {
      endpoint.candidate.name = stringProperty(store.Get(), PKEY_Device_FriendlyName);
      endpoint.candidate.deviceName = stringProperty(store.Get(), PKEY_DeviceInterface_FriendlyName);
      endpoint.candidate.containerId = guidProperty(store.Get(), PKEY_Device_ContainerId);
    }
    endpoints.push_back(std::move(endpoint));
  }
  return endpoints;
}

// Container of the physical device behind a video device interface path (the
// Media Foundation symbolic link): interface -> device instance -> container.
// Empty when any step fails; pairing then falls back to the name rule.
std::string videoContainerId(const std::string &videoDeviceId) {
  std::wstring interfacePath;
  if (!broadify::helper::tryUtf8ToWide(videoDeviceId, interfacePath) || interfacePath.empty()) {
    return "";
  }
  wchar_t instanceId[MAX_DEVICE_ID_LEN + 1] = {};
  ULONG size = sizeof(instanceId) - sizeof(wchar_t);
  DEVPROPTYPE type = DEVPROP_TYPE_EMPTY;
  if (CM_Get_Device_Interface_PropertyW(interfacePath.c_str(), &DEVPKEY_Device_InstanceId, &type, reinterpret_cast<PBYTE>(instanceId),
                                        &size, 0) != CR_SUCCESS ||
      type != DEVPROP_TYPE_STRING) {
    return "";
  }
  DEVINST instance = 0;
  if (CM_Locate_DevNodeW(&instance, instanceId, CM_LOCATE_DEVNODE_NORMAL) != CR_SUCCESS) {
    return "";
  }
  GUID container{};
  size = sizeof(container);
  type = DEVPROP_TYPE_EMPTY;
  if (CM_Get_DevNode_PropertyW(instance, &DEVPKEY_Device_ContainerId, &type, reinterpret_cast<PBYTE>(&container), &size, 0) != CR_SUCCESS ||
      type != DEVPROP_TYPE_GUID) {
    return "";
  }
  return guidString(container);
}

// Capture time on the helper's monotonic clock: WASAPI stamps each packet with
// the performance counter (100 ns units), the counter std::steady_clock runs on.
uint64_t packetTimeNs(UINT64 qpcPosition100ns, DWORD flags) {
  const uint64_t now = monotonicNowNs();
  if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0) {
    const uint64_t packetNs = static_cast<uint64_t>(qpcPosition100ns) * 100ULL;
    if (packetNs <= now && now - packetNs < 1'000'000'000ULL) {
      return packetNs;
    }
  }
  return now;
}

// Everything the capture thread needs. Shared between the source object and
// the thread: stop() only signals and lets go, because it can be called while
// the caller holds a lock the in-flight sink call is waiting for (the engine
// stops audio under its mutex) - joining there would deadlock.
struct CaptureState {
  std::string name;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  HANDLE dataEvent = nullptr;
  HANDLE stopEvent = nullptr;
  std::atomic<bool> stopping{false};
  std::mutex sinkMutex;
  AudioSink sink;

  ~CaptureState() {
    if (dataEvent != nullptr) {
      CloseHandle(dataEvent);
    }
    if (stopEvent != nullptr) {
      CloseHandle(stopEvent);
    }
  }
};

void emitAudioUnavailable(const std::string &code, const std::string &message) {
  emitHelperEvent("{\"type\":\"pgm_audio_unavailable\",\"code\":\"" + jsonEscape(code) + "\",\"message\":\"" + jsonEscape(message) + "\"}");
}

const char *openErrorCode(HRESULT hr) {
  if (hr == E_ACCESSDENIED) {
    return "microphone_permission_denied";  // microphone privacy setting
  }
  if (hr == AUDCLNT_E_DEVICE_IN_USE) {
    return "device_in_use";  // another application holds it in exclusive mode
  }
  if (hr == AUDCLNT_E_UNSUPPORTED_FORMAT) {
    return "unsupported_format";
  }
  return "audio_open_failed";
}

// Hands every packet that is ready to the sink.
HRESULT drainPackets(CaptureState &state, std::vector<float> &silence) {
  while (!state.stopping.load()) {
    UINT32 packetFrames = 0;
    HRESULT hr = state.capture->GetNextPacketSize(&packetFrames);
    if (FAILED(hr)) {
      return hr;
    }
    if (packetFrames == 0) {
      return S_OK;
    }
    BYTE *data = nullptr;
    UINT32 frames = 0;
    DWORD flags = 0;
    UINT64 devicePosition = 0;
    UINT64 qpcPosition = 0;
    hr = state.capture->GetBuffer(&data, &frames, &flags, &devicePosition, &qpcPosition);
    if (hr == AUDCLNT_S_BUFFER_EMPTY) {
      return S_OK;
    }
    if (FAILED(hr)) {
      return hr;
    }
    if (frames > 0) {
      AudioChunk chunk;
      chunk.frames = frames;
      chunk.captureNs = packetTimeNs(qpcPosition, flags);
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr) {
        silence.assign(static_cast<size_t>(frames) * kChannels, 0.0f);
        chunk.samples = silence.data();
      } else {
        chunk.samples = reinterpret_cast<const float *>(data);
      }
      AudioSink sink;
      {
        std::lock_guard<std::mutex> lock(state.sinkMutex);
        sink = state.sink;
      }
      if (sink) {
        sink(chunk);
      }
    }
    hr = state.capture->ReleaseBuffer(frames);
    if (FAILED(hr)) {
      return hr;
    }
  }
  return S_OK;
}

void captureThread(std::shared_ptr<CaptureState> state) {
  const ComApartment apartment;
  DWORD taskIndex = 0;
  const HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  const HANDLE handles[2] = {state->stopEvent, state->dataEvent};
  std::vector<float> silence;
  for (;;) {
    // The timeout only guards against a lost event; packets are drained either way.
    const DWORD wait = WaitForMultipleObjects(2, handles, FALSE, 2000);
    if (wait == WAIT_OBJECT_0 || state->stopping.load()) {
      break;
    }
    if (wait == WAIT_FAILED) {
      emitAudioUnavailable("audio_capture_failed", "Waiting for audio from " + state->name + " failed (" + std::to_string(GetLastError()) + ").");
      break;
    }
    const HRESULT hr = drainPackets(*state, silence);
    if (FAILED(hr)) {
      // Unplugged, disabled or reconfigured in the sound settings
      // (AUDCLNT_E_DEVICE_INVALIDATED and friends): the picture keeps running without sound.
      if (!state->stopping.load()) {
        emitAudioUnavailable("audio_device_lost", "The audio of " + state->name + " stopped (" + hresultHex(hr) + ").");
      }
      break;
    }
  }
  state->client->Stop();
  if (task != nullptr) {
    AvRevertMmThreadCharacteristics(task);
  }
  // COM objects go while this thread's apartment is still alive.
  state->capture.Reset();
  state->client.Reset();
}

class WasapiAudioSource final : public AudioSource {
 public:
  WasapiAudioSource(std::wstring endpointId, std::string name) : endpointId_(std::move(endpointId)), name_(std::move(name)) {}
  ~WasapiAudioSource() override { stop(); }

  bool start(AudioSink sink, std::string &errorCode, std::string &error) override {
    const ComApartment apartment;
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_) {
      return true;
    }
    std::shared_ptr<CaptureState> state = std::make_shared<CaptureState>();
    state->name = name_;
    state->sink = std::move(sink);
    const char *stage = "";
    const HRESULT hr = open(*state, stage);
    if (FAILED(hr)) {
      errorCode = openErrorCode(hr);
      error = "Could not open the audio of " + name_ + " (" + stage + " " + hresultHex(hr) + ").";
      return false;
    }
    state_ = state;
    std::thread(captureThread, std::move(state)).detach();
    return true;
  }

  void stop() override {
    std::shared_ptr<CaptureState> state;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      state.swap(state_);
    }
    if (!state) {
      return;
    }
    state->stopping.store(true);
    {
      std::lock_guard<std::mutex> lock(state->sinkMutex);
      state->sink = nullptr;
    }
    SetEvent(state->stopEvent);
    // Not joined, see CaptureState: the thread stops the stream and releases everything itself.
  }

 private:
  HRESULT open(CaptureState &state, const char *&stage) {
    stage = "events";
    state.dataEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    state.stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (state.dataEvent == nullptr || state.stopEvent == nullptr) {
      return HRESULT_FROM_WIN32(GetLastError());
    }
    stage = "enumerator";
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) {
      return hr;
    }
    stage = "device";
    ComPtr<IMMDevice> device;
    hr = enumerator->GetDevice(endpointId_.c_str(), &device);
    if (FAILED(hr)) {
      return hr;
    }
    stage = "activate";
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void **>(state.client.GetAddressOf()));
    if (FAILED(hr)) {
      return hr;
    }
    WAVEFORMATEXTENSIBLE format{};
    format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    format.Format.nChannels = kChannels;
    format.Format.nSamplesPerSec = kSampleRate;
    format.Format.wBitsPerSample = 32;
    format.Format.nBlockAlign = static_cast<WORD>(kChannels * sizeof(float));
    format.Format.nAvgBytesPerSec = kSampleRate * format.Format.nBlockAlign;
    format.Format.cbSize = static_cast<WORD>(sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX));
    format.Samples.wValidBitsPerSample = 32;
    format.dwChannelMask = 0x3;  // front left | front right
    format.SubFormat = kSubtypeIeeeFloat;
    stage = "initialize";
    // AUTOCONVERTPCM: the audio engine resamples and remixes from the device's
    // mix format (44.1 kHz, mono, more channels) to ours.
    hr = state.client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                  kBufferDuration, 0, &format.Format, nullptr);
    if (FAILED(hr)) {
      return hr;
    }
    stage = "event_handle";
    hr = state.client->SetEventHandle(state.dataEvent);
    if (FAILED(hr)) {
      return hr;
    }
    stage = "capture_client";
    hr = state.client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void **>(state.capture.GetAddressOf()));
    if (FAILED(hr)) {
      return hr;
    }
    stage = "start";
    return state.client->Start();
  }

  const std::wstring endpointId_;
  const std::string name_;
  std::shared_ptr<CaptureState> state_;
  std::mutex mutex_;
};

}  // namespace

std::unique_ptr<AudioSource> createPairedAudioSource(const std::string &videoDisplayName, const std::string &videoDeviceId) {
  const ComApartment apartment;
  const std::vector<Endpoint> endpoints = captureEndpoints();
  std::vector<AudioEndpointCandidate> candidates;
  candidates.reserve(endpoints.size());
  for (const Endpoint &endpoint : endpoints) {
    candidates.push_back(endpoint.candidate);
  }
  const AudioPairing pairing = pairAudioEndpoint(videoDisplayName, videoContainerId(videoDeviceId), candidates);
  if (pairing.index < 0) {
    emitAudioUnavailable("audio_not_paired", "No audio input belongs to " + videoDisplayName + "; the preview runs without sound.");
    return nullptr;
  }
  const Endpoint &endpoint = endpoints[static_cast<size_t>(pairing.index)];
  emitHelperEvent("{\"type\":\"pgm_audio_paired\",\"rule\":\"" + std::string(pairing.rule) + "\",\"endpoint\":\"" +
                  jsonEscape(endpoint.candidate.name) + "\",\"video\":\"" + jsonEscape(videoDisplayName) + "\"}");
  return std::make_unique<WasapiAudioSource>(endpoint.id, endpoint.candidate.name);
}

}  // namespace broadify::pgm

#endif  // _WIN32
