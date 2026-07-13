/*
  Display Helper (macOS / Windows)

  Reads RGBA frames from FrameBus shared memory and displays fullscreen via SDL2.
  No Electron, no IPC for frame data.
*/

#include "framebus.h"

#define SDL_MAIN_HANDLED
#include <SDL.h>

#include <algorithm>
#include <cctype>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dxgi1_2.h>
#else
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#endif

namespace {

std::atomic<bool> gShouldExit{false};

#if defined(_WIN32)
struct WindowsDisplayMode {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t refreshNumerator = 0;
  uint32_t refreshDenominator = 1;
  bool interlaced = false;
  bool preferred = false;
};

struct WindowsDisplayInfo {
  std::string deviceName;
  std::string monitorDevicePath;
  std::string friendlyName;
  std::string adapterLuid;
  uint32_t targetId = 0;
  int64_t outputTechnology = 0;
  int32_t x = 0;
  int32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  bool primary = false;
  std::vector<WindowsDisplayMode> modes;
};

std::string wideToUtf8(const wchar_t* value) {
  if (!value || value[0] == L'\0') {
    return std::string();
  }
  const int required = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (required <= 1) {
    return std::string();
  }
  std::string output(static_cast<size_t>(required), '\0');
  WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value,
      -1,
      output.data(),
      required,
      nullptr,
      nullptr);
  output.pop_back();
  return output;
}

std::string jsonEscape(const std::string& value) {
  std::ostringstream output;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (ch < 0x20) {
          const char hex[] = "0123456789abcdef";
          output << "\\u00" << hex[(ch >> 4) & 0x0f] << hex[ch & 0x0f];
        } else {
          output << static_cast<char>(ch);
        }
    }
  }
  return output.str();
}

std::string luidToString(const LUID& luid) {
  std::ostringstream output;
  output << std::hex << std::setfill('0')
         << std::setw(8) << static_cast<uint32_t>(luid.HighPart)
         << ":" << std::setw(8) << luid.LowPart;
  return output.str();
}

bool queryActiveDisplayConfig(
    std::vector<DISPLAYCONFIG_PATH_INFO>& paths,
    std::vector<DISPLAYCONFIG_MODE_INFO>& modes,
    std::string& error) {
  for (int attempt = 0; attempt < 3; ++attempt) {
    UINT32 pathCount = 0;
    UINT32 modeCount = 0;
    LONG status = GetDisplayConfigBufferSizes(
        QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount);
    if (status != ERROR_SUCCESS) {
      error = "GetDisplayConfigBufferSizes failed: " + std::to_string(status);
      return false;
    }
    paths.resize(pathCount);
    modes.resize(modeCount);
    status = QueryDisplayConfig(
        QDC_ONLY_ACTIVE_PATHS,
        &pathCount,
        paths.data(),
        &modeCount,
        modes.data(),
        nullptr);
    if (status == ERROR_INSUFFICIENT_BUFFER) {
      continue;
    }
    if (status != ERROR_SUCCESS) {
      error = "QueryDisplayConfig failed: " + std::to_string(status);
      return false;
    }
    paths.resize(pathCount);
    modes.resize(modeCount);
    return true;
  }
  error = "QueryDisplayConfig topology changed repeatedly";
  return false;
}

bool getDxgiOutput(
    const std::wstring& deviceName,
    IDXGIOutput** matchedOutput,
    DXGI_OUTPUT_DESC* matchedDescription) {
  *matchedOutput = nullptr;
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) {
    return false;
  }

  bool found = false;
  for (UINT adapterIndex = 0; !found; ++adapterIndex) {
    IDXGIAdapter1* adapter = nullptr;
    if (factory->EnumAdapters1(adapterIndex, &adapter) == DXGI_ERROR_NOT_FOUND) {
      break;
    }
    if (!adapter) {
      continue;
    }
    for (UINT outputIndex = 0; !found; ++outputIndex) {
      IDXGIOutput* output = nullptr;
      if (adapter->EnumOutputs(outputIndex, &output) == DXGI_ERROR_NOT_FOUND) {
        break;
      }
      if (!output) {
        continue;
      }
      DXGI_OUTPUT_DESC description{};
      if (SUCCEEDED(output->GetDesc(&description)) &&
          deviceName == description.DeviceName) {
        *matchedOutput = output;
        if (matchedDescription) {
          *matchedDescription = description;
        }
        found = true;
      } else {
        output->Release();
      }
    }
    adapter->Release();
  }
  factory->Release();
  return found;
}

void appendDxgiModes(
    const std::wstring& deviceName,
    WindowsDisplayInfo& display,
    const DISPLAYCONFIG_TARGET_PREFERRED_MODE* preferredMode) {
  IDXGIOutput* output = nullptr;
  DXGI_OUTPUT_DESC description{};
  if (!getDxgiOutput(deviceName, &output, &description) || !output) {
    return;
  }

  display.x = description.DesktopCoordinates.left;
  display.y = description.DesktopCoordinates.top;
  display.width = static_cast<uint32_t>(
      std::max<LONG>(0, description.DesktopCoordinates.right - description.DesktopCoordinates.left));
  display.height = static_cast<uint32_t>(
      std::max<LONG>(0, description.DesktopCoordinates.bottom - description.DesktopCoordinates.top));
  display.primary = display.x == 0 && display.y == 0;

  IDXGIOutput1* output1 = nullptr;
  if (FAILED(output->QueryInterface(
          __uuidof(IDXGIOutput1), reinterpret_cast<void**>(&output1))) ||
      !output1) {
    output->Release();
    return;
  }

  UINT count = 0;
  const UINT flags = DXGI_ENUM_MODES_INTERLACED | DXGI_ENUM_MODES_SCALING;
  HRESULT status = output1->GetDisplayModeList1(
      DXGI_FORMAT_R8G8B8A8_UNORM, flags, &count, nullptr);
  if (SUCCEEDED(status) && count > 0 && count <= 4096) {
    std::vector<DXGI_MODE_DESC1> descriptions(count);
    status = output1->GetDisplayModeList1(
        DXGI_FORMAT_R8G8B8A8_UNORM, flags, &count, descriptions.data());
    if (SUCCEEDED(status)) {
      std::unordered_set<std::string> seen;
      for (const auto& mode : descriptions) {
        if (mode.Width == 0 || mode.Height == 0 ||
            mode.RefreshRate.Numerator == 0 || mode.RefreshRate.Denominator == 0) {
          continue;
        }
        const bool interlaced =
            mode.ScanlineOrdering == DXGI_MODE_SCANLINE_ORDER_UPPER_FIELD_FIRST ||
            mode.ScanlineOrdering == DXGI_MODE_SCANLINE_ORDER_LOWER_FIELD_FIRST;
        const std::string key =
            std::to_string(mode.Width) + "x" + std::to_string(mode.Height) + "@" +
            std::to_string(mode.RefreshRate.Numerator) + "/" +
            std::to_string(mode.RefreshRate.Denominator) + (interlaced ? "i" : "p");
        if (!seen.insert(key).second) {
          continue;
        }
        bool preferred = false;
        if (preferredMode) {
          const auto& signal = preferredMode->targetMode.targetVideoSignalInfo;
          preferred =
              preferredMode->width == mode.Width &&
              preferredMode->height == mode.Height &&
              signal.vSyncFreq.Numerator == mode.RefreshRate.Numerator &&
              signal.vSyncFreq.Denominator == mode.RefreshRate.Denominator;
        }
        display.modes.push_back({
            mode.Width,
            mode.Height,
            mode.RefreshRate.Numerator,
            mode.RefreshRate.Denominator,
            interlaced,
            preferred,
        });
        if (display.modes.size() >= 512) {
          break;
        }
      }
    }
  }

  output1->Release();
  output->Release();
}

bool listWindowsDisplays(std::vector<WindowsDisplayInfo>& displays, std::string& error) {
  std::vector<DISPLAYCONFIG_PATH_INFO> paths;
  std::vector<DISPLAYCONFIG_MODE_INFO> configModes;
  if (!queryActiveDisplayConfig(paths, configModes, error)) {
    return false;
  }

  for (const auto& path : paths) {
    DISPLAYCONFIG_SOURCE_DEVICE_NAME sourceName{};
    sourceName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    sourceName.header.size = sizeof(sourceName);
    sourceName.header.adapterId = path.sourceInfo.adapterId;
    sourceName.header.id = path.sourceInfo.id;
    if (DisplayConfigGetDeviceInfo(&sourceName.header) != ERROR_SUCCESS ||
        sourceName.viewGdiDeviceName[0] == L'\0') {
      continue;
    }

    DISPLAYCONFIG_TARGET_DEVICE_NAME targetName{};
    targetName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
    targetName.header.size = sizeof(targetName);
    targetName.header.adapterId = path.targetInfo.adapterId;
    targetName.header.id = path.targetInfo.id;
    if (DisplayConfigGetDeviceInfo(&targetName.header) != ERROR_SUCCESS) {
      continue;
    }

    DISPLAYCONFIG_TARGET_PREFERRED_MODE preferredMode{};
    preferredMode.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_PREFERRED_MODE;
    preferredMode.header.size = sizeof(preferredMode);
    preferredMode.header.adapterId = path.targetInfo.adapterId;
    preferredMode.header.id = path.targetInfo.id;
    const bool hasPreferredMode =
        DisplayConfigGetDeviceInfo(&preferredMode.header) == ERROR_SUCCESS;

    WindowsDisplayInfo display;
    display.deviceName = wideToUtf8(sourceName.viewGdiDeviceName);
    display.monitorDevicePath = wideToUtf8(targetName.monitorDevicePath);
    display.friendlyName = wideToUtf8(targetName.monitorFriendlyDeviceName);
    if (display.friendlyName.empty()) {
      display.friendlyName = display.deviceName;
    }
    display.adapterLuid = luidToString(path.targetInfo.adapterId);
    display.targetId = path.targetInfo.id;
    display.outputTechnology = static_cast<int64_t>(path.targetInfo.outputTechnology);
    appendDxgiModes(
        sourceName.viewGdiDeviceName,
        display,
        hasPreferredMode ? &preferredMode : nullptr);

    if (display.modes.empty() && path.targetInfo.refreshRate.Numerator > 0 &&
        path.targetInfo.refreshRate.Denominator > 0) {
      uint32_t fallbackWidth = display.width;
      uint32_t fallbackHeight = display.height;
      if (hasPreferredMode && (fallbackWidth == 0 || fallbackHeight == 0)) {
        fallbackWidth = preferredMode.width;
        fallbackHeight = preferredMode.height;
      }
      if (fallbackWidth > 0 && fallbackHeight > 0) {
        display.modes.push_back({
            fallbackWidth,
            fallbackHeight,
            path.targetInfo.refreshRate.Numerator,
            path.targetInfo.refreshRate.Denominator,
            false,
            true,
        });
      }
    }
    displays.push_back(std::move(display));
  }
  return true;
}

void writeWindowsDisplayList(const std::vector<WindowsDisplayInfo>& displays) {
  std::cout << "{\"type\":\"display_list\",\"version\":1,\"displays\":[";
  for (size_t displayIndex = 0; displayIndex < displays.size(); ++displayIndex) {
    if (displayIndex > 0) std::cout << ',';
    const auto& display = displays[displayIndex];
    std::cout
        << "{\"device_name\":\"" << jsonEscape(display.deviceName)
        << "\",\"monitor_device_path\":\"" << jsonEscape(display.monitorDevicePath)
        << "\",\"friendly_name\":\"" << jsonEscape(display.friendlyName)
        << "\",\"adapter_luid\":\"" << jsonEscape(display.adapterLuid)
        << "\",\"target_id\":" << display.targetId
        << ",\"output_technology\":" << display.outputTechnology
        << ",\"x\":" << display.x
        << ",\"y\":" << display.y
        << ",\"width\":" << display.width
        << ",\"height\":" << display.height
        << ",\"primary\":" << (display.primary ? "true" : "false")
        << ",\"modes\":[";
    for (size_t modeIndex = 0; modeIndex < display.modes.size(); ++modeIndex) {
      if (modeIndex > 0) std::cout << ',';
      const auto& mode = display.modes[modeIndex];
      std::cout
          << "{\"width\":" << mode.width
          << ",\"height\":" << mode.height
          << ",\"refresh_numerator\":" << mode.refreshNumerator
          << ",\"refresh_denominator\":" << mode.refreshDenominator
          << ",\"interlaced\":" << (mode.interlaced ? "true" : "false")
          << ",\"preferred\":" << (mode.preferred ? "true" : "false")
          << '}';
    }
    std::cout << "]}";
  }
  std::cout << "]}" << std::endl;
}

bool resolveWindowsDisplayBounds(const std::string& deviceName, RECT& bounds) {
  if (deviceName.empty()) {
    return false;
  }
  const int wideLength = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, deviceName.c_str(), -1, nullptr, 0);
  if (wideLength <= 1) {
    return false;
  }
  std::wstring wideName(static_cast<size_t>(wideLength), L'\0');
  MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      deviceName.c_str(),
      -1,
      wideName.data(),
      wideLength);
  wideName.pop_back();
  IDXGIOutput* output = nullptr;
  DXGI_OUTPUT_DESC description{};
  if (!getDxgiOutput(wideName, &output, &description) || !output) {
    return false;
  }
  bounds = description.DesktopCoordinates;
  output->Release();
  return true;
}
#endif

struct FrameBusReader {
#if defined(_WIN32)
  HANDLE mapHandle = nullptr;
#else
  int fd = -1;
#endif
  uint8_t* base = nullptr;
  size_t size = 0;
  FrameBusHeader* header = nullptr;
  uint8_t* slots = nullptr;
};

uint64_t atomicLoad64(uint64_t* ptr) {
#if defined(_MSC_VER)
  return reinterpret_cast<std::atomic<uint64_t>*>(ptr)->load(std::memory_order_acquire);
#else
  return __atomic_load_n(ptr, __ATOMIC_ACQUIRE);
#endif
}

std::string normalizeFrameBusObjectName(const std::string& input) {
  if (input.empty()) {
    return std::string();
  }
#if defined(_WIN32)
  std::string sanitized;
  sanitized.reserve(input.size());
  for (char ch : input) {
    if (ch == '/' || ch == '\\') {
      continue;
    }
    sanitized.push_back(ch);
  }
  if (sanitized.empty()) {
    return std::string();
  }
  return std::string("Local\\") + sanitized;
#else
  if (input[0] == '/') {
    return input;
  }
  return std::string("/") + input;
#endif
}

bool openFrameBusReader(const std::string& name, FrameBusReader& out, std::string& error) {
  if (name.empty()) {
    error = "FrameBus name is empty";
    return false;
  }
  const std::string shmName = normalizeFrameBusObjectName(name);
  if (shmName.empty()) {
    error = "FrameBus name is invalid";
    return false;
  }

#if defined(_WIN32)
  HANDLE mapHandle = OpenFileMappingA(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, shmName.c_str());
  if (!mapHandle) {
    error = "Failed to open FrameBus shared memory";
    return false;
  }

  void* base = MapViewOfFile(mapHandle, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, 0);
  if (!base) {
    CloseHandle(mapHandle);
    error = "Failed to map FrameBus shared memory";
    return false;
  }

  MEMORY_BASIC_INFORMATION mbi{};
  if (VirtualQuery(base, &mbi, sizeof(mbi)) == 0 || mbi.RegionSize < FRAMEBUS_HEADER_SIZE) {
    UnmapViewOfFile(base);
    CloseHandle(mapHandle);
    error = "FrameBus shared memory too small";
    return false;
  }

  auto* header = static_cast<FrameBusHeader*>(base);
  if (header->magic != FRAMEBUS_MAGIC_LE || header->header_size != FRAMEBUS_HEADER_SIZE) {
    UnmapViewOfFile(base);
    CloseHandle(mapHandle);
    error = "FrameBus header invalid";
    return false;
  }

  const uint64_t expectedSize64 = static_cast<uint64_t>(FRAMEBUS_HEADER_SIZE) +
                                  static_cast<uint64_t>(header->slot_stride) *
                                      static_cast<uint64_t>(header->slot_count);
  if (expectedSize64 > static_cast<uint64_t>(mbi.RegionSize) ||
      expectedSize64 < FRAMEBUS_HEADER_SIZE) {
    UnmapViewOfFile(base);
    CloseHandle(mapHandle);
    error = "FrameBus shared memory size mismatch";
    return false;
  }

  out.mapHandle = mapHandle;
  out.base = static_cast<uint8_t*>(base);
  out.size = static_cast<size_t>(expectedSize64);
  out.header = header;
  out.slots = out.base + FRAMEBUS_HEADER_SIZE;
  return true;
#else
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
#endif
}

void closeFrameBusReader(FrameBusReader& reader) {
#if defined(_WIN32)
  if (reader.base) {
    UnmapViewOfFile(reader.base);
  }
  if (reader.mapHandle) {
    CloseHandle(reader.mapHandle);
  }
  reader.mapHandle = nullptr;
#else
  if (reader.base && reader.size > 0) {
    munmap(reader.base, reader.size);
  }
  if (reader.fd >= 0) {
    close(reader.fd);
  }
  reader.fd = -1;
#endif
  reader.base = nullptr;
  reader.size = 0;
  reader.header = nullptr;
  reader.slots = nullptr;
}

void signalHandler(int) {
  gShouldExit.store(true);
}

}  // namespace

int main(int argc, char* argv[]) {
  std::string frameBusName;
  std::string displayDeviceName;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 50;
  int displayIndex = 0;
  bool listDisplays = false;

  // Parse CLI args
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--framebus-name" && i + 1 < argc) {
      frameBusName = argv[++i];
    } else if (arg == "--width" && i + 1 < argc) {
      width = static_cast<uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--height" && i + 1 < argc) {
      height = static_cast<uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--fps" && i + 1 < argc) {
      fps = static_cast<uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--display-index" && i + 1 < argc) {
      displayIndex = std::atoi(argv[++i]);
    } else if (arg == "--display-device-name" && i + 1 < argc) {
      displayDeviceName = argv[++i];
    } else if (arg == "--list-displays") {
      listDisplays = true;
    }
  }

  if (listDisplays) {
#if defined(_WIN32)
    std::vector<WindowsDisplayInfo> displays;
    std::string error;
    if (!listWindowsDisplays(displays, error)) {
      std::cerr << "Display discovery failed: " << error << std::endl;
      return 1;
    }
    writeWindowsDisplayList(displays);
    return 0;
#else
    std::cerr << "Display discovery is only available on Windows" << std::endl;
    return 1;
#endif
  }

  // Fallback to env
  if (frameBusName.empty()) {
    const char* env = std::getenv("BRIDGE_FRAMEBUS_NAME");
    if (env) frameBusName = env;
  }
  if (width == 0) {
    const char* env = std::getenv("BRIDGE_FRAME_WIDTH");
    if (env) width = static_cast<uint32_t>(std::atoi(env));
  }
  if (height == 0) {
    const char* env = std::getenv("BRIDGE_FRAME_HEIGHT");
    if (env) height = static_cast<uint32_t>(std::atoi(env));
  }
  if (fps == 0) {
    const char* env = std::getenv("BRIDGE_FRAME_FPS");
    if (env) fps = static_cast<uint32_t>(std::atoi(env));
  }
  if (fps == 0) fps = 50;

  if (frameBusName.empty()) {
    std::cerr << "Display Helper: framebus name required (--framebus-name or BRIDGE_FRAMEBUS_NAME)" << std::endl;
    return 1;
  }
  if (width == 0 || height == 0) {
    std::cerr << "Display Helper: width and height required (--width/--height or env)" << std::endl;
    return 1;
  }

  signal(SIGTERM, signalHandler);
  signal(SIGINT, signalHandler);

  FrameBusReader reader;
  std::string fbError;
  if (!openFrameBusReader(frameBusName, reader, fbError)) {
    std::cerr << "FrameBus open failed: " << fbError << std::endl;
    return 1;
  }

  if (reader.header->width != width || reader.header->height != height) {
    std::cerr << "FrameBus size mismatch: expected " << width << "x" << height
              << " got " << reader.header->width << "x" << reader.header->height << std::endl;
    closeFrameBusReader(reader);
    return 1;
  }
  if (reader.header->pixel_format != FRAMEBUS_PIXELFORMAT_RGBA8) {
    std::cerr << "FrameBus pixel format mismatch (expected RGBA8)" << std::endl;
    closeFrameBusReader(reader);
    return 1;
  }

  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0) {
    std::cerr << "SDL_Init failed: " << SDL_GetError() << std::endl;
    closeFrameBusReader(reader);
    return 1;
  }

  // Resolve display index from match name (e.g. "Odyssey G5") if provided.
  const char* matchNameEnv = std::getenv("BRIDGE_DISPLAY_MATCH_NAME");
  std::string matchName = matchNameEnv ? matchNameEnv : "";
  const char* matchWidthEnv = std::getenv("BRIDGE_DISPLAY_MATCH_WIDTH");
  const char* matchHeightEnv = std::getenv("BRIDGE_DISPLAY_MATCH_HEIGHT");
  const int matchWidth = matchWidthEnv ? std::atoi(matchWidthEnv) : 0;
  const int matchHeight = matchHeightEnv ? std::atoi(matchHeightEnv) : 0;
  const int numDisplays = SDL_GetNumVideoDisplays();
  if (numDisplays <= 0) {
    std::cerr << "No SDL displays available: " << SDL_GetError() << std::endl;
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }
  if (displayIndex < 0 || displayIndex >= numDisplays) {
    displayIndex = 0;
  }
  bool matchedByName = false;
#if defined(_WIN32)
  if (!displayDeviceName.empty()) {
    RECT nativeBounds{};
    if (!resolveWindowsDisplayBounds(displayDeviceName, nativeBounds)) {
      std::cerr << "Selected Windows display device was not found" << std::endl;
      SDL_Quit();
      closeFrameBusReader(reader);
      return 1;
    }
    bool matchedNativeDisplay = false;
    for (int i = 0; i < numDisplays; ++i) {
      SDL_Rect bounds;
      if (SDL_GetDisplayBounds(i, &bounds) != 0) {
        continue;
      }
      if (bounds.x == nativeBounds.left && bounds.y == nativeBounds.top &&
          bounds.w == nativeBounds.right - nativeBounds.left &&
          bounds.h == nativeBounds.bottom - nativeBounds.top) {
        displayIndex = i;
        matchedNativeDisplay = true;
        break;
      }
    }
    if (!matchedNativeDisplay) {
      std::cerr << "Selected Windows display could not be mapped to SDL" << std::endl;
      SDL_Quit();
      closeFrameBusReader(reader);
      return 1;
    }
    matchedByName = true;
  }
#endif
  if (!matchedByName && !matchName.empty()) {
    std::string matchLower = matchName;
    std::transform(matchLower.begin(), matchLower.end(), matchLower.begin(), ::tolower);
    for (int i = 0; i < numDisplays; ++i) {
      const char* name = SDL_GetDisplayName(i);
      if (name) {
        std::string dispName = name;
        std::transform(dispName.begin(), dispName.end(), dispName.begin(), ::tolower);
        if (dispName.find(matchLower) != std::string::npos) {
          displayIndex = i;
          matchedByName = true;
          break;
        }
      }
    }
  }
  if (!matchedByName && matchWidth > 0 && matchHeight > 0) {
    for (int i = 0; i < numDisplays; ++i) {
      SDL_Rect bounds;
      if (SDL_GetDisplayBounds(i, &bounds) != 0) {
        continue;
      }
      if (bounds.w == matchWidth && bounds.h == matchHeight) {
        displayIndex = i;
        break;
      }
    }
  }

  SDL_Rect displayBounds;
  if (SDL_GetDisplayBounds(displayIndex, &displayBounds) != 0) {
    std::cerr << "SDL_GetDisplayBounds failed: " << SDL_GetError() << std::endl;
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  // Use FULLSCREEN_DESKTOP instead of FULLSCREEN: on macOS, FULLSCREEN uses
  // exclusive mode that blocks CMD+Tab, mouse, and makes the system unresponsive.
  // FULLSCREEN_DESKTOP allows normal macOS multitasking while still filling the display.
  SDL_Window* window = SDL_CreateWindow(
    "Broadify Display Output",
    displayBounds.x, displayBounds.y,
    displayBounds.w, displayBounds.h,
    SDL_WINDOW_FULLSCREEN_DESKTOP | SDL_WINDOW_SHOWN
  );
  if (!window) {
    std::cerr << "SDL_CreateWindow failed: " << SDL_GetError() << std::endl;
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  SDL_Renderer* renderer = SDL_CreateRenderer(
    window, -1,
    SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC
  );
  if (!renderer) {
    std::cerr << "SDL_CreateRenderer failed: " << SDL_GetError() << std::endl;
    SDL_DestroyWindow(window);
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  SDL_Texture* texture = SDL_CreateTexture(
    renderer,
    SDL_PIXELFORMAT_RGBA32,
    SDL_TEXTUREACCESS_STREAMING,
    static_cast<int>(width),
    static_cast<int>(height)
  );
  if (!texture) {
    std::cerr << "SDL_CreateTexture failed: " << SDL_GetError() << std::endl;
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  std::cout << "{\"type\":\"ready\"}" << std::endl;
  std::cout.flush();

  const size_t frameSize = reader.header->frame_size;
  uint64_t lastSeq = 0;
  const std::chrono::milliseconds frameInterval(fps > 0 ? std::max(1, 1000 / static_cast<int>(fps)) : 16);
  auto nextFrameAt = std::chrono::steady_clock::now();

#if !defined(_WIN32)
  // Parent-death watchdog: exit if the bridge process that spawned us dies
  // without sending SIGTERM (e.g. crash or force-quit). Otherwise this
  // fullscreen window would linger after the bridge is gone.
  const pid_t initialParentPid = getppid();
#endif

  while (!gShouldExit.load()) {
#if !defined(_WIN32)
    if (getppid() != initialParentPid) {
      gShouldExit.store(true);
      break;
    }
#endif
    const uint64_t seq = atomicLoad64(&reader.header->seq);
    if (seq == 0 || seq == lastSeq) {
      SDL_Event e;
      while (SDL_PollEvent(&e)) {
        if (e.type == SDL_QUIT) gShouldExit.store(true);
        if (e.type == SDL_KEYDOWN) {
          const bool quitShortcut =
              e.key.keysym.sym == SDLK_q &&
              ((e.key.keysym.mod & KMOD_GUI) || (e.key.keysym.mod & KMOD_CTRL));
          if (e.key.keysym.sym == SDLK_ESCAPE ||
              quitShortcut) {
            gShouldExit.store(true);
          }
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }
    lastSeq = seq;

    const uint32_t slotIndex = static_cast<uint32_t>((seq - 1) % reader.header->slot_count);
    const uint8_t* slotPtr = reader.slots + (static_cast<size_t>(slotIndex) * reader.header->slot_stride);

    void* texPixels = nullptr;
    int texPitch = 0;
    if (SDL_LockTexture(texture, nullptr, &texPixels, &texPitch) == 0) {
      const size_t srcRowBytes = width * 4;
      if (static_cast<size_t>(texPitch) == srcRowBytes) {
        std::memcpy(texPixels, slotPtr, frameSize);
      } else {
        for (uint32_t y = 0; y < height; ++y) {
          std::memcpy(
            static_cast<uint8_t*>(texPixels) + y * static_cast<size_t>(texPitch),
            slotPtr + y * srcRowBytes,
            srcRowBytes
          );
        }
      }
      SDL_UnlockTexture(texture);
    }

    SDL_RenderClear(renderer);
    SDL_RenderCopy(renderer, texture, nullptr, nullptr);
    SDL_RenderPresent(renderer);

    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) gShouldExit.store(true);
      if (e.type == SDL_KEYDOWN) {
        const bool quitShortcut =
            e.key.keysym.sym == SDLK_q &&
            ((e.key.keysym.mod & KMOD_GUI) || (e.key.keysym.mod & KMOD_CTRL));
        if (e.key.keysym.sym == SDLK_ESCAPE ||
            quitShortcut) {
          gShouldExit.store(true);
        }
      }
    }

    nextFrameAt += frameInterval;
    auto now = std::chrono::steady_clock::now();
    if (now < nextFrameAt) {
      std::this_thread::sleep_until(nextFrameAt);
    } else {
      nextFrameAt = now;
    }
  }

  SDL_DestroyTexture(texture);
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  closeFrameBusReader(reader);

  return 0;
}
