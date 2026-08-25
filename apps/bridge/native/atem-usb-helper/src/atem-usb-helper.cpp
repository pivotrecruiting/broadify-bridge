/*
  ATEM USB Helper (macOS + Windows)

  Bridges the official Blackmagic ATEM Switchers SDK for USB-attached
  switchers. All SDK calls live in this helper process so that SDK crashes
  or blocking calls can never take down the bridge (same doctrine as the
  DeckLink helper).

  Modes:
    --probe : connect via USB only (empty device address per SDK manual),
              print a single JSON status object to stdout and exit.
    --run   : long-lived session. Reads one JSON command per line on stdin,
              emits one JSON event per line on stdout:
                commands: connect, disconnect, list_macros,
                          macro_run {index}, macro_stop, shutdown
                events:   ready, connected, macros, macro_state,
                          disconnected, error

  Platform notes:
  - macOS: SDK runtime loaded at runtime by BMDSwitcherAPIDispatch from
    /Library/Application Support/Blackmagic Design/Switchers/. Missing ATEM
    software degrades to sdk_available=false / atem_software_not_installed.
  - Windows: real COM. CoCreateInstance tries the known 9.x and 10.x
    Discovery generations. If neither COM class is registered, the helper
    reports atem_software_not_installed with the raw HRESULTs.

  Threading: SDK callbacks arrive on SDK-owned threads, stdin commands on a
  dedicated reader thread; stdout writes are serialized by a mutex and all
  session state is guarded by a session mutex. Session teardown happens only
  via explicit commands, never from callback threads.
*/

#if defined(_WIN32)
#include <windows.h>
#include <objbase.h>
#include "bmd_switcher_interop_win.h"
#else
#include <BMDSwitcherAPI.h>
#include <CoreFoundation/CFPlugInCOM.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <atomic>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#define HELPER_STDMETHOD STDMETHODCALLTYPE
#else
#define HELPER_STDMETHOD
#endif

namespace {

#ifndef HELPER_SDK_IDL_SHA
#define HELPER_SDK_IDL_SHA "unbuilt"
#endif
#ifndef HELPER_SDK_DISCOVERY_CLSID
#define HELPER_SDK_DISCOVERY_CLSID "unbuilt"
#endif
#ifndef HELPER_SDK_VERSION
#define HELPER_SDK_VERSION "unbuilt"
#endif

#if defined(_WIN32)
using PlatformStringT = BSTR;
std::atomic<long> g_lastDiscoveryHrV97{0};
std::atomic<long> g_lastDiscoveryHrV100{0};
std::atomic<int> g_discoveryGeneration{0};
#else
using PlatformStringT = CFStringRef;
const REFIID kIID_IUnknown = CFUUIDGetUUIDBytes(IUnknownUUID);
#endif

std::mutex gStdoutMutex;

void emitLine(const std::string &json) {
  std::lock_guard<std::mutex> lock(gStdoutMutex);
  std::cout << json << std::endl;
}

std::string platformStringToStdString(PlatformStringT value) {
  if (!value) {
    return "";
  }
#if defined(_WIN32)
  const int length = static_cast<int>(SysStringLen(value));
  if (length == 0) {
    return "";
  }
  const int utf8Size = WideCharToMultiByte(CP_UTF8, 0, value, length, nullptr, 0, nullptr, nullptr);
  if (utf8Size <= 0) {
    return "";
  }
  std::string result(static_cast<size_t>(utf8Size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, length, result.data(), utf8Size, nullptr, nullptr);
  return result;
#else
  CFIndex length = CFStringGetLength(value);
  CFIndex maxSize =
      CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string result(maxSize, '\0');
  if (CFStringGetCString(value, result.data(), maxSize, kCFStringEncodingUTF8)) {
    result.resize(std::strlen(result.c_str()));
    return result;
  }
  return "";
#endif
}

void releasePlatformString(PlatformStringT value) {
  if (!value) {
    return;
  }
#if defined(_WIN32)
  SysFreeString(value);
#else
  CFRelease(value);
#endif
}

/** Creates the SDK discovery object; nullptr = ATEM software not installed. */
IBMDSwitcherDiscovery *createSwitcherDiscovery() {
#if defined(_WIN32)
  IBMDSwitcherDiscovery *discovery = nullptr;
  HRESULT result = CoCreateInstance(
      CLSID_CBMDSwitcherDiscovery_v97, nullptr, CLSCTX_ALL,
      IID_IBMDSwitcherDiscovery_v97, reinterpret_cast<void **>(&discovery));
  g_lastDiscoveryHrV97.store(static_cast<long>(result));
  if (SUCCEEDED(result)) {
    g_lastDiscoveryHrV100.store(0);
    g_discoveryGeneration.store(9);
    return discovery;
  }

  discovery = nullptr;
  result = CoCreateInstance(
      CLSID_CBMDSwitcherDiscovery_v100, nullptr, CLSCTX_ALL,
      IID_IBMDSwitcherDiscovery_v100, reinterpret_cast<void **>(&discovery));
  g_lastDiscoveryHrV100.store(static_cast<long>(result));
  if (SUCCEEDED(result)) {
    g_discoveryGeneration.store(10);
    return discovery;
  }

  g_discoveryGeneration.store(0);
  return nullptr;
#else
  return CreateBMDSwitcherDiscoveryInstance();
#endif
}

/** USB-only connect: empty device address per the ATEM SDK manual. */
HRESULT connectViaUsb(IBMDSwitcherDiscovery *discovery, IBMDSwitcher **switcher,
                      BMDSwitcherConnectToFailure *failReason) {
#if defined(_WIN32)
  BSTR emptyAddress = SysAllocString(L"");
  const HRESULT result = discovery->ConnectTo(emptyAddress, switcher, failReason);
  SysFreeString(emptyAddress);
  return result;
#else
  return discovery->ConnectTo(CFSTR(""), switcher, failReason);
#endif
}

std::string jsonEscape(const std::string &value) {
  std::ostringstream out;
  for (char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          out << "\\u" << std::hex << static_cast<int>(c);
        } else {
          out << c;
        }
    }
  }
  return out.str();
}

void appendHelperBuildJson(std::ostringstream &out) {
  out << "\"helper_build\":{\"sdk_idl_sha\":\"" << jsonEscape(HELPER_SDK_IDL_SHA)
      << "\",\"sdk_discovery_clsid\":\"" << jsonEscape(HELPER_SDK_DISCOVERY_CLSID)
      << "\",\"sdk_version\":\"" << jsonEscape(HELPER_SDK_VERSION) << "\"}";
}

#if defined(_WIN32)
std::string formatHRESULT(HRESULT result) {
  std::ostringstream out;
  out << "0x" << std::hex << std::uppercase << std::setw(8) << std::setfill('0')
      << static_cast<unsigned long>(result);
  return out.str();
}

std::string discoveryHrJson() {
  return formatHRESULT(static_cast<HRESULT>(g_lastDiscoveryHrV97.load()));
}

std::string discoveryHrV100Json() {
  return formatHRESULT(static_cast<HRESULT>(g_lastDiscoveryHrV100.load()));
}

std::string discoveryGenerationJson() {
  const int generation = g_discoveryGeneration.load();
  if (generation == 9) {
    return "9";
  }
  if (generation == 10) {
    return "10";
  }
  return "none";
}

void appendWindowsDiscoveryJson(std::ostringstream &out, bool includeBothHrs) {
  out << ",\"sdk_generation\":\"" << discoveryGenerationJson() << "\""
      << ",\"discovery_hr\":\"" << discoveryHrJson() << "\"";
  if (includeBothHrs) {
    out << ",\"discovery_hr_v97\":\"" << discoveryHrJson() << "\""
        << ",\"discovery_hr_v100\":\"" << discoveryHrV100Json() << "\"";
  }
}

std::string discoveryMissingDetail() {
  return "CoCreateInstance hr=" + discoveryHrJson() + " (v97=" + discoveryHrJson() +
         ", v100=" + discoveryHrV100Json() + ")";
}
#endif

// Minimal field extraction for the flat command objects this helper accepts
// (same hand-rolled approach as the meeting helper's control server; no
// third-party JSON dependency in native helpers).
std::string extractJsonString(const std::string &line, const std::string &key) {
  const std::string needle = "\"" + key + "\":\"";
  const size_t start = line.find(needle);
  if (start == std::string::npos) {
    return "";
  }
  const size_t valueStart = start + needle.size();
  size_t end = valueStart;
  while (end < line.size()) {
    if (line[end] == '"' && line[end - 1] != '\\') {
      break;
    }
    ++end;
  }
  return line.substr(valueStart, end - valueStart);
}

bool extractJsonUInt(const std::string &line, const std::string &key, uint32_t &value) {
  const std::string needle = "\"" + key + "\":";
  const size_t start = line.find(needle);
  if (start == std::string::npos) {
    return false;
  }
  size_t pos = start + needle.size();
  while (pos < line.size() && line[pos] == ' ') {
    ++pos;
  }
  if (pos >= line.size() || !std::isdigit(static_cast<unsigned char>(line[pos]))) {
    return false;
  }
  value = static_cast<uint32_t>(std::strtoul(line.c_str() + pos, nullptr, 10));
  return true;
}

std::string connectFailureToError(BMDSwitcherConnectToFailure reason) {
  switch (reason) {
    case bmdSwitcherConnectToFailureNoResponse:
      return "no_usb_switcher_found";
    case bmdSwitcherConnectToFailureIncompatibleFirmware:
      return "incompatible_firmware";
    case bmdSwitcherConnectToFailureCorruptData:
      return "corrupt_data";
    case bmdSwitcherConnectToFailureStateSync:
      return "state_sync_failed";
    case bmdSwitcherConnectToFailureStateSyncTimedOut:
      return "state_sync_timed_out";
    default:
      return "connect_failed";
  }
}

void emitError(const std::string &error, const std::string &detail = "") {
  std::ostringstream out;
  out << "{\"type\":\"error\",\"error\":\"" << jsonEscape(error) << "\"";
  if (!detail.empty()) {
    out << ",\"detail\":\"" << jsonEscape(detail) << "\"";
  }
  out << "}";
  emitLine(out.str());
}

// Shared IUnknown boilerplate for the three SDK callback delegates below
// (mirrors the DeckLink helper's callback classes; real COM on Windows).
template <typename InterfaceT>
class CallbackBase : public InterfaceT {
 public:
  explicit CallbackBase(REFIID interfaceIid) : refCount_(1), interfaceIid_(interfaceIid) {}
  virtual ~CallbackBase() = default;

  HRESULT HELPER_STDMETHOD QueryInterface(REFIID iid, void **ppv) override {
    if (!ppv) {
      return E_POINTER;
    }
#if defined(_WIN32)
    const bool matches = IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, interfaceIid_);
#else
    const bool matches =
        std::memcmp(&iid, &kIID_IUnknown, sizeof(REFIID)) == 0 ||
        std::memcmp(&iid, &interfaceIid_, sizeof(REFIID)) == 0;
#endif
    if (matches) {
      *ppv = this;
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG HELPER_STDMETHOD AddRef() override { return ++refCount_; }

  ULONG HELPER_STDMETHOD Release() override {
    const ULONG remaining = --refCount_;
    if (remaining == 0) {
      delete this;
    }
    return remaining;
  }

 private:
  std::atomic<ULONG> refCount_;
#if defined(_WIN32)
  IID interfaceIid_;
#else
  REFIID interfaceIid_;
#endif
};

class SwitcherMonitor : public CallbackBase<IBMDSwitcherCallback> {
 public:
  explicit SwitcherMonitor(std::function<void()> onDisconnected)
      : CallbackBase(IID_IBMDSwitcherCallback), onDisconnected_(std::move(onDisconnected)) {}

  HRESULT HELPER_STDMETHOD Notify(BMDSwitcherEventType eventType,
                                  BMDSwitcherVideoMode) override {
    if (eventType == bmdSwitcherEventTypeDisconnected && onDisconnected_) {
      onDisconnected_();
    }
    return S_OK;
  }

 private:
  std::function<void()> onDisconnected_;
};

class MacroPoolMonitor : public CallbackBase<IBMDSwitcherMacroPoolCallback> {
 public:
  explicit MacroPoolMonitor(std::function<void()> onPoolChanged)
      : CallbackBase(IID_IBMDSwitcherMacroPoolCallback), onPoolChanged_(std::move(onPoolChanged)) {}

  HRESULT HELPER_STDMETHOD Notify(BMDSwitcherMacroPoolEventType, uint32_t,
                                  IBMDSwitcherTransferMacro *) override {
    if (onPoolChanged_) {
      onPoolChanged_();
    }
    return S_OK;
  }

 private:
  std::function<void()> onPoolChanged_;
};

class MacroControlMonitor : public CallbackBase<IBMDSwitcherMacroControlCallback> {
 public:
  explicit MacroControlMonitor(std::function<void()> onRunStatusChanged)
      : CallbackBase(IID_IBMDSwitcherMacroControlCallback),
        onRunStatusChanged_(std::move(onRunStatusChanged)) {}

  HRESULT HELPER_STDMETHOD Notify(BMDSwitcherMacroControlEventType eventType) override {
    if (eventType == bmdSwitcherMacroControlEventTypeRunStatusChanged && onRunStatusChanged_) {
      onRunStatusChanged_();
    }
    return S_OK;
  }

 private:
  std::function<void()> onRunStatusChanged_;
};

// Owns the SDK objects of one USB switcher session. All public methods are
// serialized by mutex_; callback lambdas only read SDK objects and emit
// events, never mutate or release session state (teardown happens solely in
// disconnectLocked, driven by explicit commands).
class RunSession {
 public:
  ~RunSession() { disconnect(); }

  void connect() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (switcher_ != nullptr) {
      emitError("already_connected");
      return;
    }
    if (discovery_ == nullptr) {
      discovery_ = createSwitcherDiscovery();
    }
    if (discovery_ == nullptr) {
#if defined(_WIN32)
      emitError("atem_software_not_installed", discoveryMissingDetail());
#else
      emitError("atem_software_not_installed");
#endif
      return;
    }
    BMDSwitcherConnectToFailure failReason = bmdSwitcherConnectToFailureNoResponse;
    if (connectViaUsb(discovery_, &switcher_, &failReason) != S_OK ||
        switcher_ == nullptr) {
      switcher_ = nullptr;
      emitError(connectFailureToError(failReason));
      return;
    }

    switcher_->QueryInterface(IID_IBMDSwitcherMacroPool,
                              reinterpret_cast<void **>(&macroPool_));
    switcher_->QueryInterface(IID_IBMDSwitcherMacroControl,
                              reinterpret_cast<void **>(&macroControl_));

    switcherMonitor_ = new SwitcherMonitor([this]() {
      connectedFlag_.store(false);
      emitLine("{\"type\":\"disconnected\"}");
    });
    switcher_->AddCallback(switcherMonitor_);
    if (macroPool_ != nullptr) {
      poolMonitor_ = new MacroPoolMonitor([this]() { emitMacrosUnlocked(); });
      macroPool_->AddCallback(poolMonitor_);
    }
    if (macroControl_ != nullptr) {
      controlMonitor_ = new MacroControlMonitor([this]() { emitMacroStateUnlocked(); });
      macroControl_->AddCallback(controlMonitor_);
    }

    connectedFlag_.store(true);
    std::string productName;
    PlatformStringT productNameRef = nullptr;
    if (switcher_->GetProductName(&productNameRef) == S_OK && productNameRef) {
      productName = platformStringToStdString(productNameRef);
      releasePlatformString(productNameRef);
    }
    emitLine("{\"type\":\"connected\",\"product_name\":\"" + jsonEscape(productName) + "\"}");
    emitMacrosUnlocked();
    emitMacroStateUnlocked();
  }

  void disconnect() {
    std::lock_guard<std::mutex> lock(mutex_);
    disconnectLocked(true);
  }

  void listMacros() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!requireConnected()) {
      return;
    }
    emitMacrosUnlocked();
  }

  void runMacro(uint32_t index) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!requireConnected() || macroControl_ == nullptr || macroPool_ == nullptr) {
      return;
    }
    bool isValid = false;
    if (!macroIsValid(index, isValid) || !isValid) {
      emitError("invalid_macro_index");
      return;
    }
    if (macroControl_->Run(index) != S_OK) {
      emitError("macro_run_failed");
    }
  }

  void stopMacro() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!requireConnected() || macroControl_ == nullptr) {
      return;
    }
    if (macroControl_->StopRunning() != S_OK) {
      emitError("macro_stop_failed");
    }
  }

 private:
  bool requireConnected() {
    if (switcher_ == nullptr || !connectedFlag_.load()) {
      emitError("not_connected");
      return false;
    }
    return true;
  }

  // The Windows IDL surfaces booleans as BOOL, macOS as bool.
  bool macroIsValid(uint32_t index, bool &isValid) {
#if defined(_WIN32)
    BOOL valid = FALSE;
    if (macroPool_->IsValid(index, &valid) != S_OK) {
      return false;
    }
    isValid = valid != FALSE;
#else
    bool valid = false;
    if (macroPool_->IsValid(index, &valid) != S_OK) {
      return false;
    }
    isValid = valid;
#endif
    return true;
  }

  void disconnectLocked(bool emitEvent) {
    if (switcher_ == nullptr) {
      return;
    }
    if (controlMonitor_ != nullptr && macroControl_ != nullptr) {
      macroControl_->RemoveCallback(controlMonitor_);
    }
    if (poolMonitor_ != nullptr && macroPool_ != nullptr) {
      macroPool_->RemoveCallback(poolMonitor_);
    }
    if (switcherMonitor_ != nullptr) {
      switcher_->RemoveCallback(switcherMonitor_);
    }
    releaseAndClear(controlMonitor_);
    releaseAndClear(poolMonitor_);
    releaseAndClear(switcherMonitor_);
    releaseAndClear(macroControl_);
    releaseAndClear(macroPool_);
    releaseAndClear(switcher_);
    const bool wasConnected = connectedFlag_.exchange(false);
    if (emitEvent && wasConnected) {
      emitLine("{\"type\":\"disconnected\"}");
    }
  }

  template <typename T>
  static void releaseAndClear(T *&object) {
    if (object != nullptr) {
      object->Release();
      object = nullptr;
    }
  }

  void emitMacrosUnlocked() {
    if (macroPool_ == nullptr) {
      emitLine("{\"type\":\"macros\",\"macros\":[]}");
      return;
    }
    uint32_t maxCount = 0;
    macroPool_->GetMaxCount(&maxCount);
    std::ostringstream out;
    out << "{\"type\":\"macros\",\"macros\":[";
    bool first = true;
    for (uint32_t i = 0; i < maxCount; ++i) {
      bool isValid = false;
      if (!macroIsValid(i, isValid) || !isValid) {
        continue;
      }
      std::string name;
      std::string description;
      PlatformStringT nameRef = nullptr;
      if (macroPool_->GetName(i, &nameRef) == S_OK && nameRef) {
        name = platformStringToStdString(nameRef);
        releasePlatformString(nameRef);
      }
      PlatformStringT descriptionRef = nullptr;
      if (macroPool_->GetDescription(i, &descriptionRef) == S_OK && descriptionRef) {
        description = platformStringToStdString(descriptionRef);
        releasePlatformString(descriptionRef);
      }
      if (!first) {
        out << ",";
      }
      first = false;
      out << "{\"id\":" << i << ",\"name\":\"" << jsonEscape(name)
          << "\",\"description\":\"" << jsonEscape(description) << "\"}";
    }
    out << "]}";
    emitLine(out.str());
  }

  void emitMacroStateUnlocked() {
    if (macroControl_ == nullptr) {
      return;
    }
    BMDSwitcherMacroRunStatus status = bmdSwitcherMacroRunStatusIdle;
    uint32_t index = 0;
#if defined(_WIN32)
    BOOL loop = FALSE;
#else
    bool loop = false;
#endif
    if (macroControl_->GetRunStatus(&status, &loop, &index) != S_OK) {
      return;
    }
    const char *statusName = "idle";
    if (status == bmdSwitcherMacroRunStatusRunning) {
      statusName = "running";
    } else if (status == bmdSwitcherMacroRunStatusWaitingForUser) {
      statusName = "waiting";
    }
    std::ostringstream out;
    out << "{\"type\":\"macro_state\",\"status\":\"" << statusName
        << "\",\"loop\":" << (loop ? "true" : "false") << ",\"index\":" << index << "}";
    emitLine(out.str());
  }

  std::mutex mutex_;
  std::atomic<bool> connectedFlag_{false};
  IBMDSwitcherDiscovery *discovery_ = nullptr;
  IBMDSwitcher *switcher_ = nullptr;
  IBMDSwitcherMacroPool *macroPool_ = nullptr;
  IBMDSwitcherMacroControl *macroControl_ = nullptr;
  SwitcherMonitor *switcherMonitor_ = nullptr;
  MacroPoolMonitor *poolMonitor_ = nullptr;
  MacroControlMonitor *controlMonitor_ = nullptr;
};

int runProbe() {
  IBMDSwitcherDiscovery *discovery = createSwitcherDiscovery();
  if (discovery == nullptr) {
    std::ostringstream out;
    out << "{\"mode\":\"probe\",\"sdk_available\":false,\"connected\":false,"
        << "\"error\":\"atem_software_not_installed\"";
#if defined(_WIN32)
    out << ",\"detail\":\"" << jsonEscape(discoveryMissingDetail()) << "\"";
    appendWindowsDiscoveryJson(out, true);
#endif
    out << ",";
    appendHelperBuildJson(out);
    out << "}";
    std::cout << out.str() << std::endl;
    return 0;
  }

  IBMDSwitcher *switcher = nullptr;
  BMDSwitcherConnectToFailure failReason = bmdSwitcherConnectToFailureNoResponse;
  const HRESULT result = connectViaUsb(discovery, &switcher, &failReason);
  if (result != S_OK || switcher == nullptr) {
    std::ostringstream out;
    out << "{\"mode\":\"probe\",\"sdk_available\":true,\"connected\":false,"
        << "\"error\":\"" << connectFailureToError(failReason) << "\"";
#if defined(_WIN32)
    appendWindowsDiscoveryJson(out, false);
#endif
    out << ",";
    appendHelperBuildJson(out);
    out << "}";
    std::cout << out.str() << std::endl;
    discovery->Release();
    return 0;
  }

  std::string productName;
  PlatformStringT productNameRef = nullptr;
  if (switcher->GetProductName(&productNameRef) == S_OK && productNameRef) {
    productName = platformStringToStdString(productNameRef);
    releasePlatformString(productNameRef);
  }

  uint32_t macroSlots = 0;
  uint32_t validMacros = 0;
  IBMDSwitcherMacroPool *macroPool = nullptr;
  if (switcher->QueryInterface(IID_IBMDSwitcherMacroPool,
                               reinterpret_cast<void **>(&macroPool)) == S_OK &&
      macroPool != nullptr) {
    macroPool->GetMaxCount(&macroSlots);
    for (uint32_t i = 0; i < macroSlots; ++i) {
#if defined(_WIN32)
      BOOL valid = FALSE;
      if (macroPool->IsValid(i, &valid) == S_OK && valid) {
        ++validMacros;
      }
#else
      bool valid = false;
      if (macroPool->IsValid(i, &valid) == S_OK && valid) {
        ++validMacros;
      }
#endif
    }
    macroPool->Release();
  }

  std::ostringstream out;
  out << "{\"mode\":\"probe\",\"sdk_available\":true,\"connected\":true,"
      << "\"product_name\":\"" << jsonEscape(productName) << "\","
      << "\"macro_slots\":" << macroSlots << ","
      << "\"valid_macros\":" << validMacros;
#if defined(_WIN32)
  appendWindowsDiscoveryJson(out, false);
#endif
  out << ",";
  appendHelperBuildJson(out);
  out << "}";
  std::cout << out.str() << std::endl;

  switcher->Release();
  discovery->Release();
  return 0;
}

int runSessionLoop() {
  RunSession session;
  std::ostringstream ready;
  ready << "{\"type\":\"ready\",";
#if defined(_WIN32)
  ready << "\"sdk_generation\":\"" << discoveryGenerationJson() << "\",";
#endif
  appendHelperBuildJson(ready);
  ready << "}";
  emitLine(ready.str());

  std::thread readerThread([&session]() {
#if defined(_WIN32)
    // MTA: every thread issuing COM calls initializes COM for itself.
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
#endif
    std::string line;
    while (std::getline(std::cin, line)) {
      const std::string command = extractJsonString(line, "command");
      if (command == "connect") {
        session.connect();
      } else if (command == "disconnect") {
        session.disconnect();
      } else if (command == "list_macros") {
        session.listMacros();
      } else if (command == "macro_run") {
        uint32_t index = 0;
        if (extractJsonUInt(line, "index", index)) {
          session.runMacro(index);
        } else {
          emitError("missing_macro_index");
        }
      } else if (command == "macro_stop") {
        session.stopMacro();
      } else if (command == "shutdown") {
        break;
      } else {
        emitError("unknown_command", command);
      }
    }
    // stdin closed or shutdown requested: tear down and let main exit.
    session.disconnect();
#if defined(_WIN32)
    CoUninitialize();
#else
    CFRunLoopStop(CFRunLoopGetMain());
#endif
  });

#if !defined(_WIN32)
  // macOS: keep a runloop available so SDK callback delivery never depends
  // on our command loop. (Windows MTA callbacks arrive on RPC threads.)
  CFRunLoopRun();
#endif
  readerThread.join();
  return 0;
}

void printUsage() {
  std::cerr << "Usage: atem-usb-helper --probe | --run" << std::endl;
}

}  // namespace

int main(int argc, char **argv) {
#if defined(_WIN32)
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    emitError("com_init_failed");
    return 1;
  }
#endif
  int exitCode = 2;
  if (argc >= 2 && std::strcmp(argv[1], "--probe") == 0) {
    exitCode = runProbe();
  } else if (argc >= 2 && std::strcmp(argv[1], "--run") == 0) {
    exitCode = runSessionLoop();
  } else {
    printUsage();
  }
#if defined(_WIN32)
  CoUninitialize();
#endif
  return exitCode;
}
