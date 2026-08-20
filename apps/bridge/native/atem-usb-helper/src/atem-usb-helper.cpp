/*
  ATEM USB Helper (macOS)

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

  The SDK runtime is loaded at runtime by BMDSwitcherAPIDispatch from
  /Library/Application Support/Blackmagic Design/Switchers/. When the ATEM
  software is not installed, the helper reports sdk_available=false /
  atem_software_not_installed instead of failing to launch.

  Threading: SDK callbacks arrive on SDK-owned threads, stdin commands on a
  dedicated reader thread; stdout writes are serialized by a mutex and all
  session state is guarded by a session mutex. The main thread runs a
  CFRunLoop so SDK callback delivery never depends on our command loop.
*/

#include <BMDSwitcherAPI.h>
#include <CoreFoundation/CFPlugInCOM.h>
#include <CoreFoundation/CoreFoundation.h>

#include <atomic>
#include <cstring>
#include <functional>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

const REFIID kIID_IUnknown = CFUUIDGetUUIDBytes(IUnknownUUID);

std::mutex gStdoutMutex;

void emitLine(const std::string &json) {
  std::lock_guard<std::mutex> lock(gStdoutMutex);
  std::cout << json << std::endl;
}

std::string cfStringToStdString(CFStringRef cfString) {
  if (!cfString) {
    return "";
  }
  CFIndex length = CFStringGetLength(cfString);
  CFIndex maxSize =
      CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string result(maxSize, '\0');
  if (CFStringGetCString(cfString, result.data(), maxSize, kCFStringEncodingUTF8)) {
    result.resize(std::strlen(result.c_str()));
    return result;
  }
  return "";
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
// (mirrors the DeckLink helper's callback classes).
template <typename InterfaceT>
class CallbackBase : public InterfaceT {
 public:
  explicit CallbackBase(REFIID interfaceIid) : refCount_(1), interfaceIid_(interfaceIid) {}
  virtual ~CallbackBase() = default;

  HRESULT QueryInterface(REFIID iid, void **ppv) override {
    if (!ppv) {
      return E_POINTER;
    }
    if (std::memcmp(&iid, &kIID_IUnknown, sizeof(REFIID)) == 0 ||
        std::memcmp(&iid, &interfaceIid_, sizeof(REFIID)) == 0) {
      *ppv = this;
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG AddRef() override { return ++refCount_; }

  ULONG Release() override {
    const ULONG remaining = --refCount_;
    if (remaining == 0) {
      delete this;
    }
    return remaining;
  }

 private:
  std::atomic<ULONG> refCount_;
  REFIID interfaceIid_;
};

class SwitcherMonitor : public CallbackBase<IBMDSwitcherCallback> {
 public:
  explicit SwitcherMonitor(std::function<void()> onDisconnected)
      : CallbackBase(IID_IBMDSwitcherCallback), onDisconnected_(std::move(onDisconnected)) {}

  HRESULT Notify(BMDSwitcherEventType eventType, BMDSwitcherVideoMode) override {
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

  HRESULT Notify(BMDSwitcherMacroPoolEventType, uint32_t, IBMDSwitcherTransferMacro *) override {
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

  HRESULT Notify(BMDSwitcherMacroControlEventType eventType) override {
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
      discovery_ = CreateBMDSwitcherDiscoveryInstance();
    }
    if (discovery_ == nullptr) {
      emitError("atem_software_not_installed");
      return;
    }
    BMDSwitcherConnectToFailure failReason = bmdSwitcherConnectToFailureNoResponse;
    // Empty device address = USB-only connect (ATEM SDK manual, ConnectTo).
    if (discovery_->ConnectTo(CFSTR(""), &switcher_, &failReason) != S_OK ||
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
    CFStringRef productNameRef = nullptr;
    if (switcher_->GetProductName(&productNameRef) == S_OK && productNameRef) {
      productName = cfStringToStdString(productNameRef);
      CFRelease(productNameRef);
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
    bool valid = false;
    if (macroPool_->IsValid(index, &valid) != S_OK || !valid) {
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
      bool valid = false;
      if (macroPool_->IsValid(i, &valid) != S_OK || !valid) {
        continue;
      }
      std::string name;
      std::string description;
      CFStringRef nameRef = nullptr;
      if (macroPool_->GetName(i, &nameRef) == S_OK && nameRef) {
        name = cfStringToStdString(nameRef);
        CFRelease(nameRef);
      }
      CFStringRef descriptionRef = nullptr;
      if (macroPool_->GetDescription(i, &descriptionRef) == S_OK && descriptionRef) {
        description = cfStringToStdString(descriptionRef);
        CFRelease(descriptionRef);
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
    bool loop = false;
    uint32_t index = 0;
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
  IBMDSwitcherDiscovery *discovery = CreateBMDSwitcherDiscoveryInstance();
  if (discovery == nullptr) {
    std::cout << "{\"mode\":\"probe\",\"sdk_available\":false,\"connected\":false,"
              << "\"error\":\"atem_software_not_installed\"}" << std::endl;
    return 0;
  }

  IBMDSwitcher *switcher = nullptr;
  BMDSwitcherConnectToFailure failReason = bmdSwitcherConnectToFailureNoResponse;
  HRESULT result = discovery->ConnectTo(CFSTR(""), &switcher, &failReason);
  if (result != S_OK || switcher == nullptr) {
    std::cout << "{\"mode\":\"probe\",\"sdk_available\":true,\"connected\":false,"
              << "\"error\":\"" << connectFailureToError(failReason) << "\"}"
              << std::endl;
    discovery->Release();
    return 0;
  }

  std::string productName;
  CFStringRef productNameRef = nullptr;
  if (switcher->GetProductName(&productNameRef) == S_OK && productNameRef) {
    productName = cfStringToStdString(productNameRef);
    CFRelease(productNameRef);
  }

  uint32_t macroSlots = 0;
  uint32_t validMacros = 0;
  IBMDSwitcherMacroPool *macroPool = nullptr;
  if (switcher->QueryInterface(IID_IBMDSwitcherMacroPool,
                               reinterpret_cast<void **>(&macroPool)) == S_OK &&
      macroPool != nullptr) {
    macroPool->GetMaxCount(&macroSlots);
    for (uint32_t i = 0; i < macroSlots; ++i) {
      bool valid = false;
      if (macroPool->IsValid(i, &valid) == S_OK && valid) {
        ++validMacros;
      }
    }
    macroPool->Release();
  }

  std::cout << "{\"mode\":\"probe\",\"sdk_available\":true,\"connected\":true,"
            << "\"product_name\":\"" << jsonEscape(productName) << "\","
            << "\"macro_slots\":" << macroSlots << ","
            << "\"valid_macros\":" << validMacros << "}" << std::endl;

  switcher->Release();
  discovery->Release();
  return 0;
}

int runSessionLoop() {
  RunSession session;
  emitLine("{\"type\":\"ready\"}");

  std::thread readerThread([&session]() {
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
    // stdin closed or shutdown requested: leave the run loop so main exits.
    session.disconnect();
    CFRunLoopStop(CFRunLoopGetMain());
  });

  // SDK callback delivery must not depend on the command loop.
  CFRunLoopRun();
  readerThread.join();
  return 0;
}

void printUsage() {
  std::cerr << "Usage: atem-usb-helper --probe | --run" << std::endl;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc >= 2 && std::strcmp(argv[1], "--probe") == 0) {
    return runProbe();
  }
  if (argc >= 2 && std::strcmp(argv[1], "--run") == 0) {
    return runSessionLoop();
  }
  printUsage();
  return 2;
}
