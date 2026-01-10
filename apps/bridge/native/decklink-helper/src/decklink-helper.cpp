/*
  DeckLink Helper (macOS)

  Modes:
    --list  : print JSON array of devices to stdout
    --watch : print JSON events (one per line) to stdout
*/

#include <DeckLinkAPI.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreFoundation/CFPlugInCOM.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <csignal>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> gShouldExit{false};
const REFIID kIID_IUnknown = CFUUIDGetUUIDBytes(IUnknownUUID);

struct DeviceInfo {
  std::string id;
  std::string displayName;
  std::string vendor;
  std::string model;
  std::vector<std::string> outputConnections;
  bool busy = false;
  bool supportsPlayback = false;
};

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

std::string jsonEscape(const std::string& input) {
  std::ostringstream out;
  for (char c : input) {
    switch (c) {
      case '\"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          out << "\\u" << std::hex << std::uppercase << (int)c << std::dec;
        } else {
          out << c;
        }
        break;
    }
  }
  return out.str();
}

bool getIntAttribute(IDeckLinkProfileAttributes* attributes,
                     BMDDeckLinkAttributeID id,
                     int64_t& value) {
  if (!attributes) {
    return false;
  }
  return attributes->GetInt(id, &value) == S_OK;
}

std::string getStringAttribute(IDeckLinkProfileAttributes* attributes,
                               BMDDeckLinkAttributeID id) {
  if (!attributes) {
    return "";
  }
  CFStringRef cfString = nullptr;
  if (attributes->GetString(id, &cfString) != S_OK || !cfString) {
    return "";
  }
  std::string result = cfStringToStdString(cfString);
  CFRelease(cfString);
  return result;
}

std::string normalizeIdComponent(const std::string& input) {
  std::string output;
  output.reserve(input.size());
  for (char c : input) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_') {
      output.push_back(c);
    } else {
      output.push_back('_');
    }
  }
  return output;
}

std::string buildStableId(IDeckLinkProfileAttributes* attributes,
                          const std::string& displayName) {
  int64_t persistentId = 0;
  if (getIntAttribute(attributes, BMDDeckLinkPersistentID, persistentId) &&
      persistentId != 0) {
    std::ostringstream id;
    id << "decklink-pid-" << std::hex << persistentId;
    return id.str();
  }

  std::string handle = getStringAttribute(attributes, BMDDeckLinkDeviceHandle);
  if (!handle.empty()) {
    return "decklink-handle-" + normalizeIdComponent(handle);
  }

  int64_t topologicalId = 0;
  int64_t subDeviceIndex = 0;
  if (getIntAttribute(attributes, BMDDeckLinkTopologicalID, topologicalId) &&
      getIntAttribute(attributes, BMDDeckLinkSubDeviceIndex, subDeviceIndex)) {
    std::ostringstream id;
    id << "decklink-topo-" << std::hex << topologicalId << "-sub-"
       << std::dec << subDeviceIndex;
    return id.str();
  }

  return "decklink-" + normalizeIdComponent(displayName);
}

std::vector<std::string> getOutputConnections(
    IDeckLinkProfileAttributes* attributes) {
  std::vector<std::string> connections;
  int64_t outputConnections = 0;
  if (!getIntAttribute(attributes, BMDDeckLinkVideoOutputConnections,
                       outputConnections)) {
    return connections;
  }

  if (outputConnections & bmdVideoConnectionSDI ||
      outputConnections & bmdVideoConnectionOpticalSDI) {
    connections.push_back("sdi");
  }

  if (outputConnections & bmdVideoConnectionHDMI) {
    connections.push_back("hdmi");
  }

  return connections;
}

bool getSupportsPlayback(IDeckLinkProfileAttributes* attributes) {
  int64_t ioSupport = 0;
  if (!getIntAttribute(attributes, BMDDeckLinkVideoIOSupport, ioSupport)) {
    return false;
  }
  return (ioSupport & bmdDeviceSupportsPlayback) != 0;
}

bool getPlaybackBusy(IDeckLink* deckLink) {
  if (!deckLink) {
    return false;
  }
  IDeckLinkStatus* status = nullptr;
  if (deckLink->QueryInterface(IID_IDeckLinkStatus, (void**)&status) != S_OK) {
    return false;
  }
  int64_t busyFlags = 0;
  bool busy = false;
  if (status->GetInt(bmdDeckLinkStatusBusy, &busyFlags) == S_OK) {
    busy = (busyFlags & bmdDevicePlaybackBusy) != 0;
  }
  status->Release();
  return busy;
}

DeviceInfo buildDeviceInfo(IDeckLink* deckLink) {
  DeviceInfo info;
  if (!deckLink) {
    return info;
  }

  CFStringRef displayName = nullptr;
  if (deckLink->GetDisplayName(&displayName) == S_OK && displayName) {
    info.displayName = cfStringToStdString(displayName);
    CFRelease(displayName);
  }

  IDeckLinkProfileAttributes* attributes = nullptr;
  if (deckLink->QueryInterface(IID_IDeckLinkProfileAttributes,
                               (void**)&attributes) == S_OK) {
    info.vendor = getStringAttribute(attributes, BMDDeckLinkVendorName);
    info.model = getStringAttribute(attributes, BMDDeckLinkModelName);
    info.outputConnections = getOutputConnections(attributes);
    info.supportsPlayback = getSupportsPlayback(attributes);
    info.id = buildStableId(attributes, info.displayName);
    attributes->Release();
  } else {
    info.id = buildStableId(nullptr, info.displayName);
  }

  info.busy = getPlaybackBusy(deckLink);
  return info;
}

void printDeviceJson(std::ostream& out, const DeviceInfo& device) {
  out << "{";
  out << "\"id\":\"" << jsonEscape(device.id) << "\",";
  out << "\"displayName\":\"" << jsonEscape(device.displayName) << "\",";
  if (!device.vendor.empty()) {
    out << "\"vendor\":\"" << jsonEscape(device.vendor) << "\",";
  }
  if (!device.model.empty()) {
    out << "\"model\":\"" << jsonEscape(device.model) << "\",";
  }
  out << "\"videoOutputConnections\":[";
  for (size_t i = 0; i < device.outputConnections.size(); ++i) {
    out << "\"" << jsonEscape(device.outputConnections[i]) << "\"";
    if (i + 1 < device.outputConnections.size()) {
      out << ",";
    }
  }
  out << "],";
  out << "\"busy\":" << (device.busy ? "true" : "false") << ",";
  out << "\"supportsPlayback\":" << (device.supportsPlayback ? "true" : "false");
  out << "}";
}

std::vector<DeviceInfo> enumerateDevices() {
  std::vector<DeviceInfo> devices;
  IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
  if (!iterator) {
    std::cerr << "DeckLink iterator could not be created. Check drivers."
              << std::endl;
    return devices;
  }

  IDeckLink* deckLink = nullptr;
  while (iterator->Next(&deckLink) == S_OK) {
    devices.push_back(buildDeviceInfo(deckLink));
    deckLink->Release();
  }

  iterator->Release();
  return devices;
}

class DeckLinkNotificationCallback : public IDeckLinkDeviceNotificationCallback {
public:
  DeckLinkNotificationCallback() : refCount(1) {}

  ~DeckLinkNotificationCallback() override {
    // Release retained device references on shutdown.
    for (auto& entry : devices) {
      if (entry.deckLink) {
        entry.deckLink->Release();
      }
    }
  }

  HRESULT QueryInterface(REFIID iid, void** ppv) override {
    if (!ppv) {
      return E_POINTER;
    }
    if (std::memcmp(&iid, &kIID_IUnknown, sizeof(REFIID)) == 0 ||
        std::memcmp(&iid, &IID_IDeckLinkDeviceNotificationCallback,
                    sizeof(REFIID)) == 0) {
      *ppv = this;
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  ULONG AddRef() override {
    return ++refCount;
  }

  ULONG Release() override {
    ULONG newCount = --refCount;
    if (newCount == 0) {
      delete this;
    }
    return newCount;
  }

  HRESULT DeckLinkDeviceArrived(IDeckLink* deckLink) override {
    if (!deckLink) {
      return S_OK;
    }

    // Retain device reference to ensure removal notifications are reliable.
    deckLink->AddRef();
    DeviceInfo info = buildDeviceInfo(deckLink);
    devices.push_back(DeviceEntry{deckLink, info});
    std::ostringstream out;
    out << "{\"type\":\"device_added\",\"devices\":[";
    printDeviceJson(out, info);
    out << "]}" << std::endl;
    std::cout << out.str();
    std::cout.flush();
    return S_OK;
  }

  HRESULT DeckLinkDeviceRemoved(IDeckLink* deckLink) override {
    if (!deckLink) {
      return S_OK;
    }

    DeviceInfo info;
    for (auto it = devices.begin(); it != devices.end(); ++it) {
      if (it->deckLink == deckLink) {
        info = it->info;
        it->deckLink->Release();
        devices.erase(it);
        break;
      }
    }
    std::ostringstream out;
    out << "{\"type\":\"device_removed\",\"devices\":[";
    printDeviceJson(out, info);
    out << "]}" << std::endl;
    std::cout << out.str();
    std::cout.flush();
    return S_OK;
  }

private:
  struct DeviceEntry {
    IDeckLink* deckLink = nullptr;
    DeviceInfo info;
  };

  std::vector<DeviceEntry> devices;
  std::atomic<ULONG> refCount;
};

}  // namespace

static void handleSignal(int signal) {
  if (signal == SIGINT || signal == SIGTERM) {
    gShouldExit.store(true);
  }
}

int main(int argc, char** argv) {
  std::signal(SIGINT, handleSignal);
  std::signal(SIGTERM, handleSignal);

  if (argc < 2) {
    std::cerr << "Usage: decklink-helper --list|--watch" << std::endl;
    return 1;
  }

  std::string mode = argv[1];
  if (mode == "--list") {
    std::vector<DeviceInfo> devices = enumerateDevices();
    std::ostringstream out;
    out << "[";
    for (size_t i = 0; i < devices.size(); ++i) {
      printDeviceJson(out, devices[i]);
      if (i + 1 < devices.size()) {
        out << ",";
      }
    }
    out << "]";
    std::cout << out.str() << std::endl;
    return 0;
  }

  if (mode == "--watch") {
    IDeckLinkDiscovery* discovery = CreateDeckLinkDiscoveryInstance();
    if (!discovery) {
      std::cerr << "DeckLink discovery could not be created." << std::endl;
      return 1;
    }

    DeckLinkNotificationCallback* callback = new DeckLinkNotificationCallback();
    if (discovery->InstallDeviceNotifications(callback) != S_OK) {
      std::cerr << "Failed to install device notifications." << std::endl;
      callback->Release();
      discovery->Release();
      return 1;
    }

    // Initial snapshot for watch clients.
    std::vector<DeviceInfo> devices = enumerateDevices();
    std::ostringstream out;
    out << "{\"type\":\"devices\",\"devices\":[";
    for (size_t i = 0; i < devices.size(); ++i) {
      printDeviceJson(out, devices[i]);
      if (i + 1 < devices.size()) {
        out << ",";
      }
    }
    out << "]}" << std::endl;
    std::cout << out.str();
    std::cout.flush();

    while (!gShouldExit.load()) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    discovery->UninstallDeviceNotifications();
    callback->Release();
    discovery->Release();
    return 0;
  }

  std::cerr << "Unknown mode: " << mode << std::endl;
  return 1;
}
