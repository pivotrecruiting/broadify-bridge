/*
  DeckLink Helper (macOS)

  Modes:
    --list       : print JSON array of devices to stdout
    --watch      : print JSON events (one per line) to stdout
    --list-modes : print JSON array of display modes for a device
*/

#include <DeckLinkAPI.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreFoundation/CFPlugInCOM.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <csignal>
#include <mutex>
#include <thread>
#include <vector>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>

#include "../../framebus/include/framebus.h"

namespace {

std::atomic<bool> gShouldExit{false};
const REFIID kIID_IUnknown = CFUUIDGetUUIDBytes(IUnknownUUID);
constexpr uint8_t kLegalMin = 16;
constexpr uint8_t kLegalMax = 235;
constexpr int kFullRange = 255;
constexpr int kLegalRange = kLegalMax - kLegalMin;

struct DeviceInfo {
  std::string id;
  std::string displayName;
  std::string vendor;
  std::string model;
  std::vector<std::string> outputConnections;
  bool busy = false;
  bool supportsPlayback = false;
  bool supportsExternalKeying = false;
  bool supportsInternalKeying = false;
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

std::string fieldDominanceLabel(BMDFieldDominance dominance) {
  switch (dominance) {
    case bmdLowerFieldFirst:
      return "interlaced_lower_first";
    case bmdUpperFieldFirst:
      return "interlaced_upper_first";
    case bmdProgressiveFrame:
      return "progressive";
    case bmdProgressiveSegmentedFrame:
      return "psf";
    case bmdUnknownFieldDominance:
    default:
      return "unknown";
  }
}

std::string pixelFormatLabel(BMDPixelFormat format) {
  switch (format) {
    case bmdFormat8BitYUV:
      return "8bit_yuv";
    case bmdFormat10BitYUV:
      return "10bit_yuv";
    case bmdFormat8BitARGB:
      return "8bit_argb";
    case bmdFormat8BitBGRA:
      return "8bit_bgra";
    default:
      return "unknown";
  }
}

std::string colorspaceLabel(BMDColorspace colorspace) {
  switch (colorspace) {
    case bmdColorspaceRec601:
      return "rec601";
    case bmdColorspaceRec709:
      return "rec709";
    case bmdColorspaceRec2020:
      return "rec2020";
    default:
      return "unknown";
  }
}

bool parsePixelFormatLabel(const std::string& value, BMDPixelFormat& outFormat) {
  if (value == "8bit_yuv" || value == "yuv8") {
    outFormat = bmdFormat8BitYUV;
    return true;
  }
  if (value == "10bit_yuv" || value == "yuv10") {
    outFormat = bmdFormat10BitYUV;
    return true;
  }
  if (value == "8bit_argb" || value == "argb") {
    outFormat = bmdFormat8BitARGB;
    return true;
  }
  if (value == "8bit_bgra" || value == "bgra") {
    outFormat = bmdFormat8BitBGRA;
    return true;
  }
  return false;
}

bool parseColorspaceLabel(const std::string& value,
                          BMDColorspace& outColorspace) {
  if (value == "auto") {
    outColorspace = bmdColorspaceUnknown;
    return true;
  }
  if (value == "rec601" || value == "bt601") {
    outColorspace = bmdColorspaceRec601;
    return true;
  }
  if (value == "rec709" || value == "bt709") {
    outColorspace = bmdColorspaceRec709;
    return true;
  }
  if (value == "rec2020" || value == "bt2020") {
    outColorspace = bmdColorspaceRec2020;
    return true;
  }
  return false;
}

struct PlaybackConfig;

bool parseOutputPort(const PlaybackConfig& config,
                     std::string& outDeviceId,
                     BMDVideoConnection& outConnection);

bool getIntAttribute(IDeckLinkProfileAttributes* attributes,
                     BMDDeckLinkAttributeID id,
                     int64_t& value) {
  if (!attributes) {
    return false;
  }
  return attributes->GetInt(id, &value) == S_OK;
}

bool getFlagAttribute(IDeckLinkProfileAttributes* attributes,
                      BMDDeckLinkAttributeID id,
                      bool& value) {
  if (!attributes) {
    return false;
  }
  bool flagValue = false;
  if (attributes->GetFlag(id, &flagValue) != S_OK) {
    return false;
  }
  value = static_cast<bool>(flagValue);
  return true;
}

class FrameBufferLock {
public:
  FrameBufferLock() = default;
  ~FrameBufferLock() { release(); }

  bool acquire(IDeckLinkMutableVideoFrame* frame, BMDBufferAccessFlags flags) {
    release();
    if (!frame) {
      return false;
    }

    flags_ = flags;
    const HRESULT queryResult = frame->QueryInterface(IID_IDeckLinkVideoBuffer,
                                                      (void**)&buffer_);
    if (queryResult != S_OK || !buffer_) {
      std::cerr << "[DeckLinkHelper] QueryInterface(IDeckLinkVideoBuffer) failed."
                << " HRESULT=0x" << std::hex << static_cast<uint32_t>(queryResult)
                << std::dec << " buffer=" << (buffer_ ? "non-null" : "null")
                << std::endl;
      return false;
    }

    const HRESULT startResult = buffer_->StartAccess(flags_);
    if (startResult != S_OK) {
      std::cerr << "[DeckLinkHelper] StartAccess failed."
                << " HRESULT=0x" << std::hex << static_cast<uint32_t>(startResult)
                << std::dec << std::endl;
      buffer_->Release();
      buffer_ = nullptr;
      return false;
    }

    const HRESULT bytesResult = buffer_->GetBytes(&bytes_);
    if (bytesResult != S_OK || !bytes_) {
      std::cerr << "[DeckLinkHelper] GetBytes failed."
                << " HRESULT=0x" << std::hex << static_cast<uint32_t>(bytesResult)
                << std::dec << " bytes=" << (bytes_ ? "non-null" : "null")
                << std::endl;
      buffer_->EndAccess(flags_);
      buffer_->Release();
      buffer_ = nullptr;
      bytes_ = nullptr;
      return false;
    }

    return true;
  }

  void* bytes() const { return bytes_; }

  void release() {
    if (!buffer_) {
      bytes_ = nullptr;
      return;
    }
    buffer_->EndAccess(flags_);
    buffer_->Release();
    buffer_ = nullptr;
    bytes_ = nullptr;
  }

private:
  IDeckLinkVideoBuffer* buffer_ = nullptr;
  void* bytes_ = nullptr;
  BMDBufferAccessFlags flags_ = bmdBufferAccessReadAndWrite;
};

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
    getFlagAttribute(attributes, BMDDeckLinkSupportsExternalKeying,
                     info.supportsExternalKeying);
    getFlagAttribute(attributes, BMDDeckLinkSupportsInternalKeying,
                     info.supportsInternalKeying);
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
  out << "\"supportsPlayback\":" << (device.supportsPlayback ? "true" : "false")
      << ",";
  out << "\"supportsExternalKeying\":"
      << (device.supportsExternalKeying ? "true" : "false") << ",";
  out << "\"supportsInternalKeying\":"
      << (device.supportsInternalKeying ? "true" : "false");
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

struct PlaybackConfig {
  std::string deviceId;
  int width = 0;
  int height = 0;
  double fps = 0;
  std::string outputPortId;
  std::string fillPortId;
  std::string keyPortId;
  std::vector<BMDPixelFormat> pixelFormatPriority;
  bool useLegalRange = true;
  BMDColorspace colorspaceOverride = bmdColorspaceUnknown;
  std::string frameBusName;
};

struct ModeListConfig {
  std::string deviceId;
  std::string outputPortId;
  int width = 0;
  int height = 0;
  double fps = 0;
  bool requireKeying = false;
};

struct PlaybackFrameHeader {
  uint32_t magic = 0;
  uint16_t version = 0;
  uint16_t type = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t timestamp = 0;
  uint32_t bufferLength = 0;
};

constexpr uint32_t kFrameMagic = 0x42524746;  // 'BRGF'
constexpr uint16_t kFrameVersion = 1;
constexpr uint16_t kFrameTypeFrame = 1;
constexpr uint16_t kFrameTypeShutdown = 2;
constexpr size_t kFrameHeaderSize = 28;
constexpr size_t kMaxQueuedFrames = 4;

struct FrameBusReader {
  int fd = -1;
  uint8_t* base = nullptr;
  size_t size = 0;
  FrameBusHeader* header = nullptr;
  uint8_t* slots = nullptr;
};

#ifndef bmdSupportedVideoModeDefault
#define bmdSupportedVideoModeDefault 0
#endif

uint32_t readUint32BE(const uint8_t* data) {
  return (static_cast<uint32_t>(data[0]) << 24) |
         (static_cast<uint32_t>(data[1]) << 16) |
         (static_cast<uint32_t>(data[2]) << 8) |
         static_cast<uint32_t>(data[3]);
}

uint16_t readUint16BE(const uint8_t* data) {
  return (static_cast<uint16_t>(data[0]) << 8) |
         static_cast<uint16_t>(data[1]);
}

uint64_t readUint64BE(const uint8_t* data) {
  return (static_cast<uint64_t>(data[0]) << 56) |
         (static_cast<uint64_t>(data[1]) << 48) |
         (static_cast<uint64_t>(data[2]) << 40) |
         (static_cast<uint64_t>(data[3]) << 32) |
         (static_cast<uint64_t>(data[4]) << 24) |
         (static_cast<uint64_t>(data[5]) << 16) |
         (static_cast<uint64_t>(data[6]) << 8) |
         static_cast<uint64_t>(data[7]);
}

uint64_t atomicLoad64(uint64_t* ptr) {
  return __atomic_load_n(ptr, __ATOMIC_ACQUIRE);
}

bool openFrameBusReader(const std::string& name, FrameBusReader& out, std::string& error) {
  if (name.empty()) {
    error = "FrameBus name is empty";
    return false;
  }
  std::string shmName = name;
  if (shmName[0] != '/') {
    shmName = "/" + shmName;
  }

  const int fd = shm_open(shmName.c_str(), O_RDWR, 0600);
  if (fd < 0) {
    error = "Failed to open FrameBus shared memory";
    return false;
  }

  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    error = "Failed to stat FrameBus shared memory";
    return false;
  }

  size_t totalSize = static_cast<size_t>(st.st_size);
  if (totalSize < FRAMEBUS_HEADER_SIZE) {
    close(fd);
    error = "FrameBus shared memory too small";
    return false;
  }

  void* base = mmap(nullptr, totalSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (base == MAP_FAILED) {
    close(fd);
    error = "Failed to map FrameBus shared memory";
    return false;
  }

  auto* header = static_cast<FrameBusHeader*>(base);
  if (header->magic != FRAMEBUS_MAGIC_LE || header->header_size != FRAMEBUS_HEADER_SIZE) {
    munmap(base, totalSize);
    close(fd);
    error = "FrameBus header invalid";
    return false;
  }

  out.fd = fd;
  out.base = static_cast<uint8_t*>(base);
  out.size = totalSize;
  out.header = header;
  out.slots = out.base + FRAMEBUS_HEADER_SIZE;
  return true;
}

void closeFrameBusReader(FrameBusReader& reader) {
  if (reader.base && reader.size > 0) {
    munmap(reader.base, reader.size);
  }
  if (reader.fd >= 0) {
    close(reader.fd);
  }
  reader.fd = -1;
  reader.base = nullptr;
  reader.size = 0;
  reader.header = nullptr;
  reader.slots = nullptr;
}

bool readExact(int fd, uint8_t* buffer, size_t length) {
  size_t total = 0;
  while (total < length) {
    ssize_t readBytes = ::read(fd, buffer + total, length - total);
    if (readBytes == 0) {
      return false;
    }
    if (readBytes < 0) {
      if (errno == EINTR) {
        continue;
      }
      return false;
    }
    total += static_cast<size_t>(readBytes);
  }
  return true;
}

bool discardBytes(int fd, size_t length) {
  std::vector<uint8_t> buffer(4096);
  size_t remaining = length;
  while (remaining > 0) {
    const size_t chunk = std::min(remaining, buffer.size());
    if (!readExact(fd, buffer.data(), chunk)) {
      return false;
    }
    remaining -= chunk;
  }
  return true;
}

class FrameQueue {
public:
  void push(std::vector<uint8_t>&& frame) {
    std::lock_guard<std::mutex> lock(mutex);
    if (frames.size() >= kMaxQueuedFrames) {
      frames.pop_front();
    }
    frames.push_back(std::move(frame));
  }

  bool pop(std::vector<uint8_t>& out) {
    std::lock_guard<std::mutex> lock(mutex);
    if (frames.empty()) {
      return false;
    }
    out = std::move(frames.front());
    frames.pop_front();
    return true;
  }

  bool empty() const {
    std::lock_guard<std::mutex> lock(mutex);
    return frames.empty();
  }

private:
  mutable std::mutex mutex;
  std::deque<std::vector<uint8_t>> frames;
};

struct PlaybackState {
  IDeckLinkOutput* output = nullptr;
  BMDPixelFormat pixelFormat = bmdFormat8BitARGB;
  BMDPixelFormat sourcePixelFormat = bmdFormat8BitBGRA;
  BMDColorspace colorspace = bmdColorspaceUnknown;
  BMDTimeValue frameDuration = 0;
  BMDTimeScale timeScale = 0;
  BMDTimeValue nextFrameTime = 0;
  int width = 0;
  int height = 0;
  bool useLegalRange = true;
  bool started = false;
  size_t prerollTarget = 3;
  size_t prerollScheduled = 0;
  FrameQueue queue;
  std::vector<uint8_t> lastFrame;
  bool hasLastFrame = false;
  IDeckLinkVideoConversion* converter = nullptr;
  std::chrono::steady_clock::time_point lastBufferedLog =
      std::chrono::steady_clock::now();
  std::chrono::steady_clock::time_point lastCompletionLog =
      std::chrono::steady_clock::now();
  uint64_t completedFrames = 0;
  uint64_t lateFrames = 0;
  uint64_t droppedFrames = 0;
  bool sampleLogged = false;
  int debugLogFramesRemaining = 2;
};

bool isYuvPixelFormat(BMDPixelFormat format) {
  return format == bmdFormat8BitYUV || format == bmdFormat10BitYUV;
}

uint8_t mapToLegalRange(uint8_t value) {
  const int scaled =
      (static_cast<int>(value) * kLegalRange + (kFullRange / 2)) / kFullRange +
      kLegalMin;
  if (scaled < kLegalMin) {
    return kLegalMin;
  }
  if (scaled > kLegalMax) {
    return kLegalMax;
  }
  return static_cast<uint8_t>(scaled);
}

std::string formatSampleSet(const uint8_t* data,
                            size_t dataSize,
                            int width,
                            int height,
                            int rowBytes) {
  const int maxX = std::max(0, width - 1);
  const int maxY = std::max(0, height - 1);
  struct SamplePoint {
    const char* name;
    int x;
    int y;
  };
  const SamplePoint points[] = {
    { "topLeft", 0, 0 },
    { "center", width / 2, height / 2 },
    { "bottomRight", maxX, maxY },
  };
  std::ostringstream out;
  for (const auto& point : points) {
    const int x = std::min(std::max(point.x, 0), maxX);
    const int y = std::min(std::max(point.y, 0), maxY);
    const size_t index = static_cast<size_t>(y) * rowBytes +
                         static_cast<size_t>(x) * 4;
    out << point.name << "=[";
    if (index + 3 < dataSize) {
      out << static_cast<int>(data[index]) << ","
          << static_cast<int>(data[index + 1]) << ","
          << static_cast<int>(data[index + 2]) << ","
          << static_cast<int>(data[index + 3]) << "]";
    } else {
      out << "invalid]";
    }
    out << " ";
  }
  return out.str();
}

bool convertRgbaToOutputRows(const uint8_t* src,
                             uint8_t* dst,
                             int width,
                             int height,
                             int dstRowBytes,
                             BMDPixelFormat pixelFormat,
                             bool useLegalRange) {
  const int srcRowBytes = width * 4;
  for (int y = 0; y < height; ++y) {
    const uint8_t* srcRow = src + y * srcRowBytes;
    uint8_t* dstRow = dst + y * dstRowBytes;
    for (int x = 0; x < width; ++x) {
      const size_t offset = static_cast<size_t>(x) * 4;
      uint8_t r = srcRow[offset];
      uint8_t g = srcRow[offset + 1];
      uint8_t b = srcRow[offset + 2];
      const uint8_t a = srcRow[offset + 3];
      if (useLegalRange) {
        r = mapToLegalRange(r);
        g = mapToLegalRange(g);
        b = mapToLegalRange(b);
      }
      switch (pixelFormat) {
        case bmdFormat8BitARGB:
          dstRow[offset] = a;
          dstRow[offset + 1] = r;
          dstRow[offset + 2] = g;
          dstRow[offset + 3] = b;
          break;
        case bmdFormat8BitBGRA:
          dstRow[offset] = b;
          dstRow[offset + 1] = g;
          dstRow[offset + 2] = r;
          dstRow[offset + 3] = a;
          break;
        default:
          return false;
      }
    }
  }
  return true;
}

bool scheduleFrame(PlaybackState& state, const std::vector<uint8_t>& frameData) {
  if (!state.output || frameData.empty()) {
    std::cerr << "[DeckLinkHelper] ScheduleFrame aborted: "
              << (!state.output ? "output=null" : "frameData=empty")
              << std::endl;
    return false;
  }

  const bool shouldLogDetails = state.debugLogFramesRemaining > 0;
  if (shouldLogDetails) {
    state.debugLogFramesRemaining -= 1;
  }

  const bool shouldLogSamples = !state.sampleLogged;
  if (shouldLogSamples) {
    const size_t inputSize =
        static_cast<size_t>(state.width) * static_cast<size_t>(state.height) * 4;
    std::cerr << "[DeckLinkHelper] Input RGBA samples (rowBytes="
              << (state.width * 4) << "): "
              << formatSampleSet(frameData.data(),
                                 inputSize,
                                 state.width,
                                 state.height,
                                 state.width * 4)
              << std::endl;
  }

  IDeckLinkVideoFrame* scheduledFrame = nullptr;

  if (isYuvPixelFormat(state.pixelFormat)) {
    if (!state.converter) {
      state.converter = CreateVideoConversionInstance();
      if (!state.converter) {
        std::cerr << "Failed to create video conversion instance." << std::endl;
        return false;
      }
    }

    int32_t srcRowBytes = 0;
    HRESULT srcRowBytesResult = state.output->RowBytesForPixelFormat(
        state.sourcePixelFormat, state.width, &srcRowBytes);
    if (srcRowBytesResult != S_OK) {
      std::cerr << "[DeckLinkHelper] RowBytesForPixelFormat failed (source): "
                << "format=" << pixelFormatLabel(state.sourcePixelFormat)
                << " width=" << state.width << " height=" << state.height
                << " hresult=0x" << std::hex
                << static_cast<uint32_t>(srcRowBytesResult) << std::dec
                << std::endl;
      return false;
    }
    if (shouldLogDetails) {
      std::cerr << "[DeckLinkHelper] RowBytesForPixelFormat (source) ok: "
                << "format=" << pixelFormatLabel(state.sourcePixelFormat)
                << " rowBytes=" << srcRowBytes << std::endl;
    }

    IDeckLinkMutableVideoFrame* srcFrame = nullptr;
    HRESULT srcCreateResult = state.output->CreateVideoFrame(
        state.width,
        state.height,
        srcRowBytes,
        state.sourcePixelFormat,
        bmdFrameFlagDefault,
        &srcFrame);
    if (srcCreateResult != S_OK) {
      std::cerr << "[DeckLinkHelper] CreateVideoFrame failed (source): "
                << "format=" << pixelFormatLabel(state.sourcePixelFormat)
                << " width=" << state.width << " height=" << state.height
                << " rowBytes=" << srcRowBytes << " hresult=0x" << std::hex
                << static_cast<uint32_t>(srcCreateResult) << std::dec
                << std::endl;
      return false;
    }
    if (shouldLogDetails) {
      std::cerr << "[DeckLinkHelper] CreateVideoFrame (source) ok: "
                << "format=" << pixelFormatLabel(state.sourcePixelFormat)
                << " width=" << state.width << " height=" << state.height
                << " rowBytes=" << srcRowBytes << std::endl;
    }

    FrameBufferLock srcLock;
    if (!srcLock.acquire(srcFrame, bmdBufferAccessWrite)) {
      std::cerr << "[DeckLinkHelper] getFrameBytes failed (source)" << std::endl;
      srcFrame->Release();
      return false;
    }

    if (!convertRgbaToOutputRows(frameData.data(),
                                 static_cast<uint8_t*>(srcLock.bytes()),
                                 state.width,
                                 state.height,
                                 srcRowBytes,
                                 state.sourcePixelFormat,
                                 state.useLegalRange)) {
      std::cerr << "Unsupported pixel format for RGBA conversion: "
                << pixelFormatLabel(state.sourcePixelFormat) << std::endl;
      srcFrame->Release();
      return false;
    }
    if (shouldLogSamples) {
      const size_t srcSize = static_cast<size_t>(srcRowBytes) *
                             static_cast<size_t>(state.height);
      std::cerr << "[DeckLinkHelper] Output samples (pre-YUV "
                << pixelFormatLabel(state.sourcePixelFormat) << ", rowBytes="
                << srcRowBytes << ", range="
                << (state.useLegalRange ? "legal" : "full") << "): "
                << formatSampleSet(static_cast<uint8_t*>(srcLock.bytes()),
                                   srcSize,
                                   state.width,
                                   state.height,
                                   srcRowBytes)
                << std::endl;
      state.sampleLogged = true;
    }

    srcLock.release();
    HRESULT converted = state.converter->ConvertNewFrame(
        srcFrame, state.pixelFormat, state.colorspace, nullptr, &scheduledFrame);
    srcFrame->Release();
    if (converted != S_OK || !scheduledFrame) {
      std::cerr << "ConvertNewFrame failed. HRESULT=0x" << std::hex
                << static_cast<uint32_t>(converted) << std::dec << std::endl;
      return false;
    }
  } else {
    IDeckLinkMutableVideoFrame* frame = nullptr;
    int32_t rowBytes = 0;
    HRESULT rowBytesResult =
        state.output->RowBytesForPixelFormat(state.pixelFormat,
                                             state.width,
                                             &rowBytes);
    if (rowBytesResult != S_OK) {
      std::cerr << "[DeckLinkHelper] RowBytesForPixelFormat failed (output): "
                << "format=" << pixelFormatLabel(state.pixelFormat)
                << " width=" << state.width << " height=" << state.height
                << " hresult=0x" << std::hex
                << static_cast<uint32_t>(rowBytesResult) << std::dec
                << std::endl;
      return false;
    }
    if (shouldLogDetails) {
      std::cerr << "[DeckLinkHelper] RowBytesForPixelFormat (output) ok: "
                << "format=" << pixelFormatLabel(state.pixelFormat)
                << " rowBytes=" << rowBytes << std::endl;
    }

    HRESULT createResult = state.output->CreateVideoFrame(state.width,
                                                          state.height,
                                                          rowBytes,
                                                          state.pixelFormat,
                                                          bmdFrameFlagDefault,
                                                          &frame);
    if (createResult != S_OK) {
      std::cerr << "[DeckLinkHelper] CreateVideoFrame failed (output): "
                << "format=" << pixelFormatLabel(state.pixelFormat)
                << " width=" << state.width << " height=" << state.height
                << " rowBytes=" << rowBytes << " hresult=0x" << std::hex
                << static_cast<uint32_t>(createResult) << std::dec << std::endl;
      return false;
    }
    if (shouldLogDetails) {
      std::cerr << "[DeckLinkHelper] CreateVideoFrame (output) ok: "
                << "format=" << pixelFormatLabel(state.pixelFormat)
                << " width=" << state.width << " height=" << state.height
                << " rowBytes=" << rowBytes << std::endl;
    }

    FrameBufferLock frameLock;
    if (!frameLock.acquire(frame, bmdBufferAccessWrite)) {
      std::cerr << "[DeckLinkHelper] getFrameBytes failed (output)" << std::endl;
      frame->Release();
      return false;
    }

    if (!convertRgbaToOutputRows(frameData.data(),
                                 static_cast<uint8_t*>(frameLock.bytes()),
                                 state.width,
                                 state.height,
                                 rowBytes,
                                 state.pixelFormat,
                                 state.useLegalRange)) {
      std::cerr << "Unsupported pixel format for RGBA conversion: "
                << pixelFormatLabel(state.pixelFormat) << std::endl;
      frame->Release();
      return false;
    }
    if (shouldLogSamples) {
      const size_t outSize =
          static_cast<size_t>(rowBytes) * static_cast<size_t>(state.height);
      std::cerr << "[DeckLinkHelper] Output samples ("
                << pixelFormatLabel(state.pixelFormat) << ", rowBytes="
                << rowBytes << ", range="
                << (state.useLegalRange ? "legal" : "full") << "): "
                << formatSampleSet(static_cast<uint8_t*>(frameLock.bytes()),
                                   outSize,
                                   state.width,
                                   state.height,
                                   rowBytes)
                << std::endl;
      state.sampleLogged = true;
    }

    frameLock.release();
    scheduledFrame = frame;
  }

  HRESULT scheduled = state.output->ScheduleVideoFrame(
      scheduledFrame, state.nextFrameTime, state.frameDuration, state.timeScale);
  if (scheduled != S_OK) {
    std::cerr << "ScheduleVideoFrame failed. HRESULT=0x" << std::hex
              << static_cast<uint32_t>(scheduled) << std::dec;
    if (shouldLogDetails) {
      std::cerr << " nextFrameTime=" << state.nextFrameTime
                << " frameDuration=" << state.frameDuration
                << " timeScale=" << state.timeScale;
    }
    std::cerr << std::endl;
    scheduledFrame->Release();
    return false;
  }

  auto now = std::chrono::steady_clock::now();
  if (now - state.lastBufferedLog >= std::chrono::seconds(2)) {
    uint32_t bufferedCount = 0;
    HRESULT countResult = state.output->GetBufferedVideoFrameCount(&bufferedCount);
    if (countResult == S_OK) {
      std::cerr << "Buffered video frame count: " << bufferedCount << std::endl;
    } else {
      std::cerr << "GetBufferedVideoFrameCount failed. HRESULT=0x" << std::hex
                << static_cast<uint32_t>(countResult) << std::dec << std::endl;
    }
    state.lastBufferedLog = now;
  }

  state.nextFrameTime += state.frameDuration;
  scheduledFrame->Release();
  return true;
}

class DeckLinkPlaybackCallback : public IDeckLinkVideoOutputCallback {
public:
  explicit DeckLinkPlaybackCallback(PlaybackState* state)
      : refCount(1), playbackState(state) {}

  HRESULT QueryInterface(REFIID iid, void** ppv) override {
    if (!ppv) {
      return E_POINTER;
    }
    if (std::memcmp(&iid, &kIID_IUnknown, sizeof(REFIID)) == 0 ||
        std::memcmp(&iid, &IID_IDeckLinkVideoOutputCallback, sizeof(REFIID)) ==
            0) {
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

  HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame* completedFrame,
                                  BMDOutputFrameCompletionResult result) override {
    (void)completedFrame;
    if (!playbackState) {
      return S_OK;
    }

    playbackState->completedFrames += 1;
    switch (result) {
      case bmdOutputFrameDisplayedLate:
        playbackState->lateFrames += 1;
        break;
      case bmdOutputFrameDropped:
      case bmdOutputFrameFlushed:
        playbackState->droppedFrames += 1;
        break;
      case bmdOutputFrameCompleted:
      default:
        break;
    }
    auto now = std::chrono::steady_clock::now();
    if (now - playbackState->lastCompletionLog >= std::chrono::seconds(1)) {
      std::cerr << "Playback stats: completed="
                << playbackState->completedFrames
                << " late=" << playbackState->lateFrames
                << " dropped=" << playbackState->droppedFrames << std::endl;
      playbackState->lastCompletionLog = now;
    }

    std::vector<uint8_t> frameData;
    if (!playbackState->queue.pop(frameData)) {
      if (playbackState->hasLastFrame) {
        frameData = playbackState->lastFrame;
      }
    }

    if (!frameData.empty()) {
      playbackState->lastFrame = frameData;
      playbackState->hasLastFrame = true;
      scheduleFrame(*playbackState, frameData);
    }
    return S_OK;
  }

  HRESULT ScheduledPlaybackHasStopped() override {
    return S_OK;
  }

private:
  std::atomic<ULONG> refCount;
  PlaybackState* playbackState = nullptr;
};

bool matchDeckLinkId(IDeckLink* deckLink, const std::string& targetId) {
  if (!deckLink) {
    return false;
  }
  IDeckLinkProfileAttributes* attributes = nullptr;
  std::string stableId;
  CFStringRef displayName = nullptr;
  std::string displayNameStr;
  if (deckLink->GetDisplayName(&displayName) == S_OK && displayName) {
    displayNameStr = cfStringToStdString(displayName);
    CFRelease(displayName);
  }

  if (deckLink->QueryInterface(IID_IDeckLinkProfileAttributes,
                               (void**)&attributes) == S_OK) {
    stableId = buildStableId(attributes, displayNameStr);
    attributes->Release();
  } else {
    stableId = buildStableId(nullptr, displayNameStr);
  }
  return stableId == targetId;
}

IDeckLink* findDeckLinkById(const std::string& targetId) {
  IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
  if (!iterator) {
    return nullptr;
  }

  IDeckLink* deckLink = nullptr;
  while (iterator->Next(&deckLink) == S_OK) {
    if (matchDeckLinkId(deckLink, targetId)) {
      iterator->Release();
      return deckLink;
    }
    deckLink->Release();
  }

  iterator->Release();
  return nullptr;
}

bool findDisplayMode(IDeckLinkOutput* output,
                     int width,
                     int height,
                     double fps,
                     const std::vector<BMDPixelFormat>& pixelFormats,
                     BMDVideoConnection connection,
                     BMDSupportedVideoModeFlags modeFlags,
                     BMDDisplayMode& outDisplayMode,
                     BMDPixelFormat& outPixelFormat,
                     BMDTimeValue& outFrameDuration,
                     BMDTimeScale& outTimeScale,
                     BMDDisplayModeFlags& outModeFlags) {
  if (!output) {
    return false;
  }

  IDeckLinkDisplayModeIterator* iterator = nullptr;
  if (output->GetDisplayModeIterator(&iterator) != S_OK || !iterator) {
    return false;
  }

  bool found = false;
  IDeckLinkDisplayMode* mode = nullptr;
  while (iterator->Next(&mode) == S_OK) {
    if (mode->GetWidth() != width || mode->GetHeight() != height) {
      mode->Release();
      continue;
    }

    BMDTimeValue frameDuration = 0;
    BMDTimeScale timeScale = 0;
    if (mode->GetFrameRate(&frameDuration, &timeScale) != S_OK ||
        frameDuration == 0 || timeScale == 0) {
      mode->Release();
      continue;
    }

    const double actualFps =
        static_cast<double>(timeScale) / static_cast<double>(frameDuration);
    if (std::abs(actualFps - fps) > 0.01) {
      mode->Release();
      continue;
    }

    for (const auto format : pixelFormats) {
      bool supported = false;
      const BMDVideoConnection modeConnection =
          connection == bmdVideoConnectionUnspecified ? bmdVideoConnectionUnspecified
                                                      : connection;
      const HRESULT hr = output->DoesSupportVideoMode(modeConnection,
                                                      mode->GetDisplayMode(),
                                                      format,
                                                      bmdNoVideoOutputConversion,
                                                      modeFlags,
                                                      nullptr,
                                                      &supported);
      if (FAILED(hr) || !supported) {
        continue;
      }

      outDisplayMode = mode->GetDisplayMode();
      outPixelFormat = format;
      outFrameDuration = frameDuration;
      outTimeScale = timeScale;
      found = true;
      break;
    }

    if (found) {
      outModeFlags = mode->GetFlags();
      mode->Release();
      break;
    }

    mode->Release();
  }

  iterator->Release();
  return found;
}

bool getDisplayModeDetails(IDeckLinkOutput* output,
                           BMDDisplayMode target,
                           std::string& outName,
                           BMDFieldDominance& outDominance,
                           BMDTimeValue& outFrameDuration,
                           BMDTimeScale& outTimeScale,
                           BMDDisplayModeFlags& outFlags) {
  if (!output) {
    return false;
  }

  IDeckLinkDisplayModeIterator* iterator = nullptr;
  if (output->GetDisplayModeIterator(&iterator) != S_OK || !iterator) {
    return false;
  }

  bool found = false;
  IDeckLinkDisplayMode* mode = nullptr;
  while (iterator->Next(&mode) == S_OK) {
    if (mode->GetDisplayMode() != target) {
      mode->Release();
      continue;
    }

    CFStringRef nameRef = nullptr;
    if (mode->GetName(&nameRef) == S_OK && nameRef) {
      outName = cfStringToStdString(nameRef);
      CFRelease(nameRef);
    } else {
      outName.clear();
    }

    outDominance = mode->GetFieldDominance();
    outFlags = mode->GetFlags();
    if (mode->GetFrameRate(&outFrameDuration, &outTimeScale) != S_OK) {
      outFrameDuration = 0;
      outTimeScale = 0;
    }

    found = true;
    mode->Release();
    break;
  }

  iterator->Release();
  return found;
}

BMDColorspace selectColorspaceFromFlags(BMDDisplayModeFlags flags, int height) {
  if (flags & bmdDisplayModeColorspaceRec2020) {
    return bmdColorspaceRec2020;
  }
  if (flags & bmdDisplayModeColorspaceRec709) {
    return bmdColorspaceRec709;
  }
  if (flags & bmdDisplayModeColorspaceRec601) {
    return bmdColorspaceRec601;
  }
  (void)height;
  return bmdColorspaceUnknown;
}

BMDColorspace fallbackColorspaceFromHeight(int height) {
  if (height > 0 && height <= 576) {
    return bmdColorspaceRec601;
  }
  return bmdColorspaceRec709;
}

bool listDisplayModes(const ModeListConfig& config, std::ostream& out) {
  if (config.deviceId.empty() || config.outputPortId.empty()) {
    std::cerr << "Device ID and output port are required for list-modes."
              << std::endl;
    return false;
  }

  std::string outputDeviceId;
  BMDVideoConnection outputConnection = bmdVideoConnectionUnspecified;
  PlaybackConfig portConfig;
  portConfig.outputPortId = config.outputPortId;
  if (!parseOutputPort(portConfig, outputDeviceId, outputConnection) ||
      outputDeviceId != config.deviceId) {
    std::cerr << "Output port does not match the selected device."
              << std::endl;
    return false;
  }

  IDeckLink* deckLink = findDeckLinkById(config.deviceId);
  if (!deckLink) {
    std::cerr << "DeckLink device not found: " << config.deviceId << std::endl;
    return false;
  }

  IDeckLinkOutput* output = nullptr;
  if (deckLink->QueryInterface(IID_IDeckLinkOutput, (void**)&output) != S_OK ||
      !output) {
    std::cerr << "Failed to acquire IDeckLinkOutput." << std::endl;
    deckLink->Release();
    return false;
  }

  IDeckLinkDisplayModeIterator* iterator = nullptr;
  if (output->GetDisplayModeIterator(&iterator) != S_OK || !iterator) {
    std::cerr << "Failed to get display mode iterator." << std::endl;
    output->Release();
    deckLink->Release();
    return false;
  }

  const std::vector<BMDPixelFormat> pixelFormats = {
      bmdFormat8BitYUV,
      bmdFormat10BitYUV,
      bmdFormat8BitARGB,
      bmdFormat8BitBGRA,
  };
  const BMDSupportedVideoModeFlags modeFlags =
      config.requireKeying ? bmdSupportedVideoModeKeying
                           : bmdSupportedVideoModeDefault;

  bool first = true;
  out << "[";
  IDeckLinkDisplayMode* mode = nullptr;
  while (iterator->Next(&mode) == S_OK) {
    const int width = static_cast<int>(mode->GetWidth());
    const int height = static_cast<int>(mode->GetHeight());
    if (config.width > 0 && width != config.width) {
      mode->Release();
      continue;
    }
    if (config.height > 0 && height != config.height) {
      mode->Release();
      continue;
    }

    BMDTimeValue frameDuration = 0;
    BMDTimeScale timeScale = 0;
    if (mode->GetFrameRate(&frameDuration, &timeScale) != S_OK ||
        frameDuration == 0 || timeScale == 0) {
      mode->Release();
      continue;
    }
    const double fps =
        static_cast<double>(timeScale) / static_cast<double>(frameDuration);
    if (config.fps > 0 &&
        std::abs(fps - static_cast<double>(config.fps)) > 0.01) {
      mode->Release();
      continue;
    }

    std::string modeName;
    CFStringRef nameRef = nullptr;
    if (mode->GetName(&nameRef) == S_OK && nameRef) {
      modeName = cfStringToStdString(nameRef);
      CFRelease(nameRef);
    }

    std::vector<std::string> supportedFormats;
    for (const auto format : pixelFormats) {
      bool supported = false;
      const HRESULT hr = output->DoesSupportVideoMode(
          outputConnection,
          mode->GetDisplayMode(),
          format,
          bmdNoVideoOutputConversion,
          modeFlags,
          nullptr,
          &supported);
      if (SUCCEEDED(hr) && supported) {
        supportedFormats.push_back(pixelFormatLabel(format));
      }
    }

    if (!first) {
      out << ",";
    }
    first = false;

    out << "{";
    out << "\"name\":\"" << jsonEscape(modeName) << "\",";
    out << "\"id\":" << static_cast<uint32_t>(mode->GetDisplayMode()) << ",";
    out << "\"width\":" << width << ",";
    out << "\"height\":" << height << ",";
    out << "\"fps\":" << std::fixed << std::setprecision(3) << fps << ",";
    out << "\"frameDuration\":" << frameDuration << ",";
    out << "\"timeScale\":" << timeScale << ",";
    out << "\"fieldDominance\":\""
        << jsonEscape(fieldDominanceLabel(mode->GetFieldDominance())) << "\",";
    out << "\"connection\":\""
        << jsonEscape(outputConnection == bmdVideoConnectionSDI
                          ? "sdi"
                          : outputConnection == bmdVideoConnectionHDMI
                                ? "hdmi"
                                : "unspecified")
        << "\",";
    out << "\"pixelFormats\":[";
    for (size_t i = 0; i < supportedFormats.size(); ++i) {
      out << "\"" << jsonEscape(supportedFormats[i]) << "\"";
      if (i + 1 < supportedFormats.size()) {
        out << ",";
      }
    }
    out << "]";
    out << "}";

    mode->Release();
  }

  out << "]";

  iterator->Release();
  output->Release();
  deckLink->Release();
  return true;
}

bool parseOutputPort(const PlaybackConfig& config,
                     std::string& outDeviceId,
                     BMDVideoConnection& outConnection) {
  if (config.outputPortId.empty()) {
    return false;
  }

  const std::string sdiFillSuffix = "-sdi-a";
  const std::string sdiSuffix = "-sdi";
  const std::string hdmiSuffix = "-hdmi";

  if (config.outputPortId.size() <= sdiSuffix.size() ||
      config.outputPortId.size() <= hdmiSuffix.size()) {
    return false;
  }

  if (config.outputPortId.size() >= sdiFillSuffix.size() &&
      config.outputPortId.compare(
          config.outputPortId.size() - sdiFillSuffix.size(),
          sdiFillSuffix.size(),
          sdiFillSuffix) == 0) {
    outDeviceId = config.outputPortId.substr(
        0, config.outputPortId.size() - sdiFillSuffix.size());
    if (outDeviceId.empty()) {
      return false;
    }
    outConnection = bmdVideoConnectionSDI;
    return true;
  }

  if (config.outputPortId.size() >= sdiSuffix.size() &&
      config.outputPortId.compare(
          config.outputPortId.size() - sdiSuffix.size(),
          sdiSuffix.size(),
          sdiSuffix) == 0) {
    outDeviceId = config.outputPortId.substr(
        0, config.outputPortId.size() - sdiSuffix.size());
    if (outDeviceId.empty()) {
      return false;
    }
    outConnection = bmdVideoConnectionSDI;
    return true;
  }

  if (config.outputPortId.size() >= hdmiSuffix.size() &&
      config.outputPortId.compare(
          config.outputPortId.size() - hdmiSuffix.size(),
          hdmiSuffix.size(),
          hdmiSuffix) == 0) {
    outDeviceId = config.outputPortId.substr(
        0, config.outputPortId.size() - hdmiSuffix.size());
    if (outDeviceId.empty()) {
      return false;
    }
    outConnection = bmdVideoConnectionHDMI;
    return true;
  }

  return false;
}

bool supportsOutputConnection(IDeckLink* deckLink,
                              BMDVideoConnection connection) {
  if (!deckLink || connection == bmdVideoConnectionUnspecified) {
    return true;
  }

  IDeckLinkProfileAttributes* attributes = nullptr;
  if (deckLink->QueryInterface(IID_IDeckLinkProfileAttributes,
                               (void**)&attributes) != S_OK ||
      !attributes) {
    return false;
  }

  int64_t outputConnections = 0;
  bool supported = false;
  if (getIntAttribute(attributes, BMDDeckLinkVideoOutputConnections,
                      outputConnections)) {
    if (connection == bmdVideoConnectionSDI) {
      supported = (outputConnections &
                   (bmdVideoConnectionSDI | bmdVideoConnectionOpticalSDI)) != 0;
    } else if (connection == bmdVideoConnectionHDMI) {
      supported = (outputConnections & bmdVideoConnectionHDMI) != 0;
    } else {
      supported = (outputConnections & connection) != 0;
    }
  }

  attributes->Release();
  return supported;
}

bool configureOutputConnection(IDeckLink* deckLink,
                               BMDVideoConnection connection) {
  if (!deckLink || connection == bmdVideoConnectionUnspecified) {
    return true;
  }

  IDeckLinkConfiguration* config = nullptr;
  if (deckLink->QueryInterface(IID_IDeckLinkConfiguration,
                               (void**)&config) != S_OK ||
      !config) {
    return false;
  }

  const HRESULT setResult =
      config->SetInt(bmdDeckLinkConfigVideoOutputConnection, connection);
  config->Release();
  return setResult == S_OK;
}

int runPlayback(const PlaybackConfig& config) {
  if (config.deviceId.empty() || config.width <= 0 || config.height <= 0 ||
      config.fps <= 0) {
    std::cerr << "Invalid playback configuration." << std::endl;
    return 1;
  }

  const bool useKeyer =
      !config.fillPortId.empty() || !config.keyPortId.empty();
  std::string outputDeviceId;
  BMDVideoConnection outputConnection = bmdVideoConnectionUnspecified;

  if (useKeyer) {
    const std::string expectedFill = config.deviceId + "-sdi-a";
    const std::string expectedKey = config.deviceId + "-sdi-b";
    if (config.fillPortId != expectedFill || config.keyPortId != expectedKey) {
      std::cerr << "Fill/key ports do not match the selected device."
                << std::endl;
      return 1;
    }
    outputDeviceId = config.deviceId;
    outputConnection = bmdVideoConnectionSDI;
  } else if (!config.outputPortId.empty()) {
    if (!parseOutputPort(config, outputDeviceId, outputConnection)) {
      std::cerr << "Output port does not match the selected device."
                << std::endl;
      return 1;
    }
    if (outputDeviceId != config.deviceId) {
      std::cerr << "Output port does not match the selected device."
                << std::endl;
      return 1;
    }
  } else {
    std::cerr << "Output port is required for video playback." << std::endl;
    return 1;
  }

  std::cerr << "Playback config: device=" << config.deviceId
            << " output="
            << (outputConnection == bmdVideoConnectionSDI
                    ? "sdi"
                    : outputConnection == bmdVideoConnectionHDMI
                          ? "hdmi"
                          : "unspecified")
            << " keying=" << (useKeyer ? "external" : "none")
            << " " << config.width << "x" << config.height
            << " fps=" << std::fixed << std::setprecision(3) << config.fps
            << std::endl;

  IDeckLink* deckLink = findDeckLinkById(config.deviceId);
  if (!deckLink) {
    std::cerr << "DeckLink device not found: " << config.deviceId << std::endl;
    return 1;
  }

  IDeckLinkOutput* output = nullptr;
  if (deckLink->QueryInterface(IID_IDeckLinkOutput, (void**)&output) != S_OK ||
      !output) {
    std::cerr << "Failed to acquire IDeckLinkOutput." << std::endl;
    deckLink->Release();
    return 1;
  }

  IDeckLinkKeyer* keyer = nullptr;
  if (useKeyer) {
    if (deckLink->QueryInterface(IID_IDeckLinkKeyer, (void**)&keyer) != S_OK ||
        !keyer) {
      std::cerr << "Failed to acquire IDeckLinkKeyer." << std::endl;
      output->Release();
      deckLink->Release();
      return 1;
    }

    IDeckLinkProfileAttributes* attributes = nullptr;
    bool supportsExternalKeying = false;
    if (deckLink->QueryInterface(IID_IDeckLinkProfileAttributes,
                                 (void**)&attributes) == S_OK) {
      getFlagAttribute(attributes, BMDDeckLinkSupportsExternalKeying,
                       supportsExternalKeying);
      attributes->Release();
    }

    if (!supportsExternalKeying) {
      std::cerr << "External keying not supported by device." << std::endl;
      keyer->Release();
      output->Release();
      deckLink->Release();
      return 1;
    }
  }

  BMDDisplayMode displayMode = bmdModeUnknown;
  BMDDisplayModeFlags displayModeFlags = 0;
  PlaybackState state;
  state.output = output;
  state.width = config.width;
  state.height = config.height;
  state.useLegalRange = config.useLegalRange;

  const BMDSupportedVideoModeFlags modeFlags =
      useKeyer ? bmdSupportedVideoModeKeying : bmdSupportedVideoModeDefault;

  std::vector<BMDPixelFormat> pixelFormats = config.pixelFormatPriority;
  if (pixelFormats.empty()) {
    // ARGB is the only permitted fallback pixel format; BGRA is disallowed.
    pixelFormats = { bmdFormat8BitARGB };
  }

  BMDPixelFormat selectedPixelFormat = bmdFormat8BitARGB;
  if (!findDisplayMode(output,
                       config.width,
                       config.height,
                       config.fps,
                       pixelFormats,
                       outputConnection,
                       modeFlags,
                       displayMode,
                       selectedPixelFormat,
                       state.frameDuration,
                       state.timeScale,
                       displayModeFlags)) {
    std::cerr << "No supported display mode for requested format." << std::endl;
    if (keyer) {
      keyer->Release();
    }
    output->Release();
    deckLink->Release();
    return 1;
  }
  state.pixelFormat = selectedPixelFormat;
  BMDColorspace autoColorspace =
      selectColorspaceFromFlags(displayModeFlags, config.height);
  if (autoColorspace == bmdColorspaceUnknown) {
    autoColorspace = fallbackColorspaceFromHeight(config.height);
    std::cerr << "Colorspace flags not provided by display mode. "
              << "Falling back to "
              << (autoColorspace == bmdColorspaceRec601 ? "rec601" : "rec709")
              << "." << std::endl;
  }

  state.colorspace = autoColorspace;
  if (config.colorspaceOverride != bmdColorspaceUnknown) {
    if (config.colorspaceOverride == bmdColorspaceRec2020 &&
        !(displayModeFlags & bmdDisplayModeColorspaceRec2020)) {
      std::cerr << "Requested colorspace rec2020 is not supported by "
                   "display mode. Using auto colorspace."
                << std::endl;
    } else {
      state.colorspace = config.colorspaceOverride;
      std::cerr << "Using colorspace override: "
                << colorspaceLabel(state.colorspace) << std::endl;
    }
  }

  {
    std::string modeName;
    BMDFieldDominance dominance = bmdUnknownFieldDominance;
    BMDTimeValue frameDuration = 0;
    BMDTimeScale timeScale = 0;
    BMDDisplayModeFlags modeFlags = 0;
    if (getDisplayModeDetails(output,
                              displayMode,
                              modeName,
                              dominance,
                              frameDuration,
                              timeScale,
                              modeFlags)) {
      const double fps =
          (frameDuration > 0 && timeScale > 0)
              ? static_cast<double>(timeScale) /
                    static_cast<double>(frameDuration)
              : 0.0;
      std::cerr << "Selected display mode: "
                << (modeName.empty() ? "unknown" : modeName) << " ("
                << config.width << "x" << config.height << " @ " << std::fixed
                << std::setprecision(3) << fps << ", "
                << fieldDominanceLabel(dominance) << ", pixelFormat "
                << pixelFormatLabel(state.pixelFormat) << ", colorspace "
                << colorspaceLabel(state.colorspace)
                << ", range " << (state.useLegalRange ? "legal" : "full")
                << ")" << std::endl;
    }
  }

  if (!supportsOutputConnection(deckLink, outputConnection)) {
    std::cerr << "Requested output connection not supported by device."
              << std::endl;
    if (keyer) {
      keyer->Release();
    }
    output->Release();
    deckLink->Release();
    return 1;
  }

  if (!configureOutputConnection(deckLink, outputConnection)) {
    std::cerr << "Failed to set output connection." << std::endl;
    if (keyer) {
      keyer->Release();
    }
    output->Release();
    deckLink->Release();
    return 1;
  }

  const HRESULT enableResult =
      output->EnableVideoOutput(displayMode, bmdVideoOutputFlagDefault);
  if (enableResult != S_OK) {
    std::cerr << "EnableVideoOutput failed. HRESULT=0x" << std::hex
              << static_cast<uint32_t>(enableResult) << std::dec << std::endl;
    if (keyer) {
      keyer->Release();
    }
    output->Release();
    deckLink->Release();
    return 1;
  }

  if (keyer) {
    const HRESULT keyerEnableResult = keyer->Enable(true);
    if (keyerEnableResult != S_OK) {
      std::cerr << "Keyer enable failed. HRESULT=0x" << std::hex
                << static_cast<uint32_t>(keyerEnableResult) << std::dec
                << std::endl;
      output->DisableVideoOutput();
      keyer->Release();
      output->Release();
      deckLink->Release();
      return 1;
    }
    const HRESULT keyerLevelResult = keyer->SetLevel(255);
    if (keyerLevelResult != S_OK) {
      std::cerr << "Keyer SetLevel failed. HRESULT=0x" << std::hex
                << static_cast<uint32_t>(keyerLevelResult) << std::dec
                << std::endl;
    }
  }

  DeckLinkPlaybackCallback* callback = new DeckLinkPlaybackCallback(&state);
  output->SetScheduledFrameCompletionCallback(callback);

  std::cout << "{\"type\":\"ready\"}" << std::endl;
  std::cout.flush();

  const size_t expectedBytes =
      static_cast<size_t>(config.width) *
      static_cast<size_t>(config.height) * 4;
  auto maybeStartPlayback = [&]() {
    if (state.started) {
      return;
    }
    while (state.prerollScheduled < state.prerollTarget) {
      std::vector<uint8_t> frameData;
      if (!state.queue.pop(frameData)) {
        break;
      }
      state.lastFrame = frameData;
      state.hasLastFrame = true;
      if (scheduleFrame(state, frameData)) {
        state.prerollScheduled += 1;
      } else {
        break;
      }
    }

    if (state.prerollScheduled >= state.prerollTarget) {
      const HRESULT startResult =
          output->StartScheduledPlayback(0, state.timeScale, 1.0);
      if (startResult == S_OK) {
        state.started = true;
      } else {
        std::cerr << "StartScheduledPlayback failed. HRESULT=0x" << std::hex
                  << static_cast<uint32_t>(startResult) << std::dec
                  << std::endl;
      }
    }
  };

  if (!config.frameBusName.empty()) {
    FrameBusReader reader;
    std::string frameBusError;
    if (!openFrameBusReader(config.frameBusName, reader, frameBusError)) {
      std::cerr << "FrameBus open failed: " << frameBusError << std::endl;
      gShouldExit.store(true);
    } else {
      if (reader.header->frame_size != expectedBytes ||
          reader.header->width != static_cast<uint32_t>(config.width) ||
          reader.header->height != static_cast<uint32_t>(config.height)) {
        std::cerr << "FrameBus header mismatch. expected="
                  << config.width << "x" << config.height
                  << " bytes=" << expectedBytes
                  << " got=" << reader.header->width << "x"
                  << reader.header->height
                  << " bytes=" << reader.header->frame_size << std::endl;
        closeFrameBusReader(reader);
        gShouldExit.store(true);
      } else if (reader.header->pixel_format != FRAMEBUS_PIXELFORMAT_RGBA8) {
        std::cerr << "FrameBus pixel format mismatch (expected RGBA8)." << std::endl;
        closeFrameBusReader(reader);
        gShouldExit.store(true);
      } else {
        uint64_t lastSeq = 0;
        while (!gShouldExit.load()) {
          const uint64_t seq = atomicLoad64(&reader.header->seq);
          if (seq == 0 || seq == lastSeq) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
          }
          lastSeq = seq;
          const uint32_t slotIndex =
              static_cast<uint32_t>((seq - 1) % reader.header->slot_count);
          const uint8_t* slotPtr =
              reader.slots + (static_cast<size_t>(slotIndex) * reader.header->slot_stride);
          std::vector<uint8_t> frameBuffer(reader.header->frame_size);
          std::memcpy(frameBuffer.data(), slotPtr, frameBuffer.size());
          state.queue.push(std::move(frameBuffer));
          maybeStartPlayback();
        }
        closeFrameBusReader(reader);
      }
    }
  } else {
    const int stdinFd = fileno(stdin);
    std::vector<uint8_t> headerBuffer(kFrameHeaderSize);
    int headerMismatchLogsRemaining = 2;
    int headerInvalidLogsRemaining = 2;

    while (!gShouldExit.load()) {
      if (!readExact(stdinFd, headerBuffer.data(), kFrameHeaderSize)) {
        break;
      }

      PlaybackFrameHeader header;
      header.magic = readUint32BE(headerBuffer.data());
      header.version = readUint16BE(headerBuffer.data() + 4);
      header.type = readUint16BE(headerBuffer.data() + 6);
      header.width = readUint32BE(headerBuffer.data() + 8);
      header.height = readUint32BE(headerBuffer.data() + 12);
      header.timestamp = readUint64BE(headerBuffer.data() + 16);
      header.bufferLength = readUint32BE(headerBuffer.data() + 24);

      if (header.magic != kFrameMagic || header.version != kFrameVersion) {
        if (headerInvalidLogsRemaining > 0) {
          std::cerr << "Invalid frame header."
                    << " magic=0x" << std::hex << header.magic
                    << " version=" << std::dec << header.version
                    << std::endl;
          headerInvalidLogsRemaining -= 1;
        }
        break;
      }

      if (header.type == kFrameTypeShutdown) {
        break;
      }

      if (header.type != kFrameTypeFrame) {
        if (header.bufferLength > 0) {
          if (!discardBytes(stdinFd, header.bufferLength)) {
            break;
          }
        }
        continue;
      }

      if (header.width != static_cast<uint32_t>(config.width) ||
          header.height != static_cast<uint32_t>(config.height) ||
          header.bufferLength != expectedBytes) {
        if (headerMismatchLogsRemaining > 0) {
          std::cerr << "Frame header mismatch. expected="
                    << config.width << "x" << config.height
                    << " bytes=" << expectedBytes
                    << " got=" << header.width << "x" << header.height
                    << " bytes=" << header.bufferLength << std::endl;
          headerMismatchLogsRemaining -= 1;
        }
        if (header.bufferLength > 0) {
          if (!discardBytes(stdinFd, header.bufferLength)) {
            break;
          }
        }
        continue;
      }

      std::vector<uint8_t> frameBuffer(header.bufferLength);
      if (!readExact(stdinFd, frameBuffer.data(), frameBuffer.size())) {
        break;
      }

      state.queue.push(std::move(frameBuffer));
      maybeStartPlayback();
    }
  }

  output->StopScheduledPlayback(0, nullptr, 0);
  if (keyer) {
    keyer->Disable();
  }
  output->DisableVideoOutput();
  output->SetScheduledFrameCompletionCallback(nullptr);

  callback->Release();
  if (keyer) {
    keyer->Release();
  }
  if (state.converter) {
    state.converter->Release();
    state.converter = nullptr;
  }
  output->Release();
  deckLink->Release();
  return 0;
}

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
    std::cerr
        << "Usage: decklink-helper --list|--watch|--list-modes|--playback"
        << std::endl;
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

  if (mode == "--list-modes") {
    ModeListConfig config;
    for (int i = 2; i < argc; ++i) {
      std::string arg = argv[i];
      if (arg == "--device" && i + 1 < argc) {
        config.deviceId = argv[++i];
        continue;
      }
      if (arg == "--output-port" && i + 1 < argc) {
        config.outputPortId = argv[++i];
        continue;
      }
      if (arg == "--width" && i + 1 < argc) {
        try {
          config.width = std::stoi(argv[++i]);
        } catch (...) {
          config.width = 0;
        }
        continue;
      }
      if (arg == "--height" && i + 1 < argc) {
        try {
          config.height = std::stoi(argv[++i]);
        } catch (...) {
          config.height = 0;
        }
        continue;
      }
      if (arg == "--fps" && i + 1 < argc) {
        try {
          config.fps = std::stod(argv[++i]);
        } catch (...) {
          config.fps = 0;
        }
        continue;
      }
      if (arg == "--keying") {
        config.requireKeying = true;
        continue;
      }
    }

    std::ostringstream out;
    if (!listDisplayModes(config, out)) {
      return 1;
    }
    std::cout << out.str() << std::endl;
    return 0;
  }

  if (mode == "--playback") {
    PlaybackConfig config;
    for (int i = 2; i < argc; ++i) {
      std::string arg = argv[i];
      if (arg == "--device" && i + 1 < argc) {
        config.deviceId = argv[++i];
        continue;
      }
      if (arg == "--width" && i + 1 < argc) {
        try {
          config.width = std::stoi(argv[++i]);
        } catch (...) {
          config.width = 0;
        }
        continue;
      }
      if (arg == "--height" && i + 1 < argc) {
        try {
          config.height = std::stoi(argv[++i]);
        } catch (...) {
          config.height = 0;
        }
        continue;
      }
      if (arg == "--fps" && i + 1 < argc) {
        try {
          config.fps = std::stod(argv[++i]);
        } catch (...) {
          config.fps = 0;
        }
        continue;
      }
      if (arg == "--fill-port" && i + 1 < argc) {
        config.fillPortId = argv[++i];
        continue;
      }
      if (arg == "--key-port" && i + 1 < argc) {
        config.keyPortId = argv[++i];
        continue;
      }
      if (arg == "--output-port" && i + 1 < argc) {
        config.outputPortId = argv[++i];
        continue;
      }
      if (arg == "--pixel-format" && i + 1 < argc) {
        const std::string value = argv[++i];
        BMDPixelFormat format = bmdFormatUnspecified;
        if (!parsePixelFormatLabel(value, format)) {
          std::cerr << "Unknown pixel format: " << value << std::endl;
          return 1;
        }
        config.pixelFormatPriority.clear();
        config.pixelFormatPriority.push_back(format);
        continue;
      }
      if (arg == "--pixel-format-priority" && i + 1 < argc) {
        const std::string value = argv[++i];
        config.pixelFormatPriority.clear();
        std::stringstream stream(value);
        std::string token;
        while (std::getline(stream, token, ',')) {
          if (token.empty()) {
            continue;
          }
          BMDPixelFormat format = bmdFormatUnspecified;
          if (!parsePixelFormatLabel(token, format)) {
            std::cerr << "Unknown pixel format: " << token << std::endl;
            return 1;
          }
          config.pixelFormatPriority.push_back(format);
        }
        if (config.pixelFormatPriority.empty()) {
          std::cerr << "Pixel format priority cannot be empty." << std::endl;
          return 1;
        }
        continue;
      }
      if (arg == "--range" && i + 1 < argc) {
        const std::string value = argv[++i];
        if (value == "full") {
          config.useLegalRange = false;
        } else if (value == "legal") {
          config.useLegalRange = true;
        } else {
          std::cerr << "Unknown range: " << value << std::endl;
          return 1;
        }
        continue;
      }
      if (arg == "--colorspace" && i + 1 < argc) {
        const std::string value = argv[++i];
        BMDColorspace override = bmdColorspaceUnknown;
        if (!parseColorspaceLabel(value, override)) {
          std::cerr << "Unknown colorspace: " << value << std::endl;
          return 1;
        }
        config.colorspaceOverride = override;
        continue;
      }
      if (arg == "--framebus-name" && i + 1 < argc) {
        config.frameBusName = argv[++i];
        continue;
      }
    }

    return runPlayback(config);
  }

  std::cerr << "Unknown mode: " << mode << std::endl;
  return 1;
}
