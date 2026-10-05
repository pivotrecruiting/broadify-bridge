#if defined(_WIN32)

#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <inspectable.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include "capture/screen_capture_source.h"
#include "capture/guarded_frame_slot.h"
#include "capture/liveness_watchdog.h"
#include "util/pixel_swizzle.h"
#include "util/json_utils.h"
#include "util/helper_event_log.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <iterator>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace broadify::meeting {
namespace {

using Microsoft::WRL::ComPtr;
namespace capture = winrt::Windows::Graphics::Capture;
namespace directx = winrt::Windows::Graphics::DirectX;
namespace direct3d11 = winrt::Windows::Graphics::DirectX::Direct3D11;
namespace foundation = winrt::Windows::Foundation;
namespace metadata = winrt::Windows::Foundation::Metadata;

constexpr directx::DirectXPixelFormat kCaptureFormat =
    directx::DirectXPixelFormat::B8G8R8A8UIntNormalized;

std::string wideToUtf8(const wchar_t *value) {
  if (value == nullptr || value[0] == L'\0') {
    return {};
  }
  const int size =
      WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) {
    return {};
  }
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), size, nullptr,
                      nullptr);
  return out;
}

std::string wideToUtf8(const std::wstring &value) {
  return wideToUtf8(value.c_str());
}

std::string hresultHex(HRESULT hr) {
  std::ostringstream out;
  out << "0x" << std::hex << std::uppercase << static_cast<uint32_t>(hr);
  return out.str();
}

std::string formatHandle(const char *kind, uintptr_t handle) {
  std::ostringstream out;
  out << kind << ":0x" << std::hex << std::uppercase << handle;
  return out.str();
}

uint64_t nowQpc() {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return static_cast<uint64_t>(value.QuadPart);
}

uint32_t halvedDimension(uint32_t value, uint32_t mipLevel) {
  return std::max<uint32_t>(1u, value >> mipLevel);
}

HRESULT winrtErrorCode(const winrt::hresult_error &error) {
  return static_cast<HRESULT>(static_cast<int32_t>(error.code()));
}

// C++/WinRT needs a WinRT apartment on every thread that uses WinRT. The
// helper control thread already owns an MTA in nearby code paths; C++/WinRT
// tolerates that (S_FALSE) and only reports RPC_E_CHANGED_MODE for an existing
// incompatible apartment.
struct WinRtApartment {
  WinRtApartment() {
    static thread_local bool initialized = false;
    if (initialized) {
      return;
    }
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (const winrt::hresult_error &error) {
      if (winrtErrorCode(error) != RPC_E_CHANGED_MODE) {
        throw;
      }
      emitHelperEvent(
          "{\"type\":\"screen_capture_winrt_apartment\",\"event\":\"changed_"
          "mode\"}");
    }
    initialized = true;
  }
};

struct SourceDescription {
  std::string sourceId;
  std::string kind;
  std::string title;
  std::string appName;
  uint32_t width = 0;
  uint32_t height = 0;
  bool primary = false;
};

std::string processBaseName(DWORD pid) {
  HANDLE process =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) {
    return {};
  }
  wchar_t path[MAX_PATH * 4] = {};
  DWORD length = static_cast<DWORD>(std::size(path));
  std::string result;
  if (QueryFullProcessImageNameW(process, 0, path, &length) && length > 0) {
    std::wstring wide(path, path + length);
    const size_t slash = wide.find_last_of(L"\\/");
    if (slash != std::wstring::npos) {
      wide = wide.substr(slash + 1u);
    }
    result = wideToUtf8(wide);
  }
  CloseHandle(process);
  return result;
}

bool windowFrameBounds(HWND hwnd, RECT &rect) {
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rect,
                                      sizeof(rect)))) {
    return true;
  }
  return GetWindowRect(hwnd, &rect) != FALSE;
}

uint32_t rectWidth(const RECT &rect) {
  return rect.right > rect.left
             ? static_cast<uint32_t>(rect.right - rect.left)
             : 0u;
}

uint32_t rectHeight(const RECT &rect) {
  return rect.bottom > rect.top
             ? static_cast<uint32_t>(rect.bottom - rect.top)
             : 0u;
}

SourceDescription describeMonitor(HMONITOR monitor) {
  SourceDescription description;
  description.sourceId =
      formatHandle("monitor", reinterpret_cast<uintptr_t>(monitor));
  description.kind = "display";

  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) {
    return description;
  }
  description.width = rectWidth(info.rcMonitor);
  description.height = rectHeight(info.rcMonitor);
  description.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;

  description.title = wideToUtf8(info.szDevice);
  DISPLAY_DEVICEW device{};
  device.cb = sizeof(device);
  if (EnumDisplayDevicesW(info.szDevice, 0, &device, 0) &&
      device.DeviceString[0] != L'\0') {
    description.title += " (" + wideToUtf8(device.DeviceString) + ")";
  }
  return description;
}

SourceDescription describeWindow(HWND hwnd) {
  SourceDescription description;
  description.sourceId =
      formatHandle("window", reinterpret_cast<uintptr_t>(hwnd));
  description.kind = "window";

  const int titleLength = GetWindowTextLengthW(hwnd);
  if (titleLength > 0) {
    std::wstring title(static_cast<size_t>(titleLength + 1), L'\0');
    const int written =
        GetWindowTextW(hwnd, title.data(), titleLength + 1);
    if (written > 0) {
      title.resize(static_cast<size_t>(written));
      description.title = wideToUtf8(title);
    }
  }

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  description.appName = processBaseName(pid);

  RECT rect{};
  if (windowFrameBounds(hwnd, rect)) {
    description.width = rectWidth(rect);
    description.height = rectHeight(rect);
  }
  return description;
}

class WgcScreenCaptureSource final : public ScreenCaptureSource {
 public:
  explicit WgcScreenCaptureSource(int parentPid) : parentPid_(parentPid) {}

  ~WgcScreenCaptureSource() override { stop(); }

  ScreenCaptureCapabilities capabilities() const override {
    static const ScreenCaptureCapabilities capabilities = [] {
      ScreenCaptureCapabilities result;
      try {
        WinRtApartment apartment;
        result.supported = capture::GraphicsCaptureSession::IsSupported();
      } catch (...) {
        result.supported = false;
      }
      result.enumeration = result.supported;
      result.systemPicker = false;
      result.permissionStatus = result.supported ? "not_required" : "unsupported";
      result.unsupportedReason = result.supported ? "" : "wgc_unavailable";
      return result;
    }();
    return capabilities;
  }

  std::vector<ScreenSourceInfo> listSources() override {
    try {
      WinRtApartment apartment;
    } catch (const winrt::hresult_error &error) {
      std::lock_guard<std::mutex> lock(mutex_);
      lastError_ = "winrt_apartment_failed";
      setStickyErrorLocked("wgc: " + hresultHex(winrtErrorCode(error)) + " " +
                           winrt::to_string(error.message()));
      return {};
    }
    std::string activeSourceId;
    bool running = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      activeSourceId = sourceId_;
      running = running_;
    }

    std::vector<ScreenSourceInfo> sources;
    struct MonitorContext {
      std::vector<ScreenSourceInfo> *sources = nullptr;
      std::string activeSourceId;
      bool running = false;
    } monitorContext{&sources, activeSourceId, running};

    const BOOL monitorsOk = EnumDisplayMonitors(
        nullptr, nullptr,
        [](HMONITOR monitor, HDC, LPRECT, LPARAM userData) -> BOOL {
          auto *context = reinterpret_cast<MonitorContext *>(userData);
          const SourceDescription description = describeMonitor(monitor);
          if (description.width == 0u || description.height == 0u) {
            return TRUE;
          }
          ScreenSourceInfo source;
          source.sourceId = description.sourceId;
          source.kind = description.kind;
          source.title = description.title;
          source.width = description.width;
          source.height = description.height;
          source.primary = description.primary;
          source.active = context->running &&
                          context->activeSourceId == description.sourceId;
          context->sources->push_back(std::move(source));
          return TRUE;
        },
        reinterpret_cast<LPARAM>(&monitorContext));
    if (!monitorsOk) {
      std::lock_guard<std::mutex> lock(mutex_);
      lastError_ = "monitor_enumeration_failed";
      return {};
    }

    struct WindowContext {
      std::vector<ScreenSourceInfo> *sources = nullptr;
      std::string activeSourceId;
      bool running = false;
      uint32_t currentPid = 0;
      uint32_t parentPid = 0;
    } windowContext{&sources,
                    activeSourceId,
                    running,
                    GetCurrentProcessId(),
                    parentPid_ > 0 ? static_cast<uint32_t>(parentPid_) : 0u};

    const BOOL windowsOk = EnumWindows(
        [](HWND hwnd, LPARAM userData) -> BOOL {
          auto *context = reinterpret_cast<WindowContext *>(userData);

          DWORD ownerPid = 0;
          GetWindowThreadProcessId(hwnd, &ownerPid);

          DWORD cloaked = 0;
          const HRESULT cloakedHr = DwmGetWindowAttribute(
              hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
          wchar_t className[256] = {};
          GetClassNameW(hwnd, className, static_cast<int>(std::size(className)));

          WindowCandidate candidate;
          candidate.visible = IsWindowVisible(hwnd) != FALSE;
          candidate.rootWindow = GetAncestor(hwnd, GA_ROOT) == hwnd;
          candidate.hasTitle = GetWindowTextLengthW(hwnd) > 0;
          candidate.toolWindow =
              (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0;
          candidate.cloaked = FAILED(cloakedHr) || cloaked != 0;
          candidate.className = wideToUtf8(className);
          candidate.ownerPid = ownerPid;
          candidate.currentPid = context->currentPid;
          candidate.parentPid = context->parentPid;
          if (!isShareableWindowCandidate(candidate)) {
            return TRUE;
          }

          const SourceDescription description = describeWindow(hwnd);
          if (description.title.empty() || description.width == 0u ||
              description.height == 0u) {
            return TRUE;
          }
          ScreenSourceInfo source;
          source.sourceId = description.sourceId;
          source.kind = description.kind;
          source.title = description.title;
          source.appName = description.appName;
          source.width = description.width;
          source.height = description.height;
          source.active = context->running &&
                          context->activeSourceId == description.sourceId;
          context->sources->push_back(std::move(source));
          return TRUE;
        },
        reinterpret_cast<LPARAM>(&windowContext));
    if (!windowsOk) {
      std::lock_guard<std::mutex> lock(mutex_);
      lastError_ = "window_enumeration_failed";
      return {};
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      lastError_.clear();
    }
    return sources;
  }

  bool start(const std::string &sourceId,
             const ScreenCaptureStartOptions &options) override {
    try {
      WinRtApartment apartment;
    } catch (const winrt::hresult_error &error) {
      handleStartError("wgc: " + hresultHex(winrtErrorCode(error)) + " " +
                       winrt::to_string(error.message()));
      return false;
    }
    std::string kind;
    uint64_t rawHandle = 0u;
    if (!parseScreenSourceId(sourceId, kind, rawHandle)) {
      setLastError("source_not_found");
      return false;
    }
    const bool windowSource = kind == "window";
    const HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(rawHandle));
    const HMONITOR hmon =
        reinterpret_cast<HMONITOR>(static_cast<uintptr_t>(rawHandle));
    if (windowSource) {
      if (!IsWindow(hwnd)) {
        setLastError("source_not_found");
        return false;
      }
    } else {
      MONITORINFOEXW info{};
      info.cbSize = sizeof(info);
      if (!GetMonitorInfoW(hmon, &info)) {
        setLastError("source_not_found");
        return false;
      }
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (running_ && sourceId_ == sourceId) {
        lastError_.clear();
        return true;
      }
    }
    if (isRunning()) {
      stopInternal("user_stop", false);
    }

    SourceDescription description =
        windowSource ? describeWindow(hwnd) : describeMonitor(hmon);
    description.sourceId = sourceId;
    description.kind = windowSource ? "window" : "display";

    // GraphicsCaptureItem.Closed is not reliably delivered in this helper
    // process. Polling the native source handle every 250 ms meets the <= 2 s
    // window/monitor loss requirement while keeping Closed as the fast path.
    auto watchdog = std::make_unique<LivenessWatchdog>(
        windowSource
            ? LivenessWatchdog::Probe(
                  [hwnd]() { return IsWindow(hwnd) != FALSE; })
            : LivenessWatchdog::Probe([hmon]() {
                MONITORINFO info{};
                info.cbSize = sizeof(info);
                return GetMonitorInfoW(hmon, &info) != FALSE;
              }),
        [this]() {
          // Runs on the watchdog's plain std::thread: enter a WinRT apartment
          // like stop() does before stopInternal() closes session and pool.
          try {
            WinRtApartment apartment;
          } catch (...) {
          }
          handleItemLost();
        },
        std::chrono::milliseconds(250));

    try {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        ensureDeviceLocked();

        item_ = windowSource ? createItemForWindow(hwnd)
                             : createItemForMonitor(hmon);
        lastSize_ = item_.Size();
        if (lastSize_.Width <= 0 || lastSize_.Height <= 0) {
          throw winrt::hresult_error(E_INVALIDARG,
                                     L"Capture item has an empty size.");
        }

        options_ = options;
        mipLevel_ =
            mipAutogenSupported_
                ? selectCaptureMipLevel(static_cast<uint32_t>(lastSize_.Width),
                                        static_cast<uint32_t>(lastSize_.Height),
                                        options.maxWidth, options.maxHeight)
                : 0u;
        width_ = halvedDimension(static_cast<uint32_t>(lastSize_.Width),
                                 mipLevel_);
        height_ = halvedDimension(static_cast<uint32_t>(lastSize_.Height),
                                  mipLevel_);

        // FreeThreaded pools (Windows 10 1809+) raise FrameArrived on the pool's
        // worker thread and do not require a DispatcherQueue.
        pool_ = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
            winrtDevice_, kCaptureFormat, 2, lastSize_);
        session_ = pool_.CreateCaptureSession(item_);

        cursorToggleSupported_ = metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession",
            L"IsCursorCaptureEnabled");
        if (cursorToggleSupported_) {
          session_.IsCursorCaptureEnabled(options.includeCursor);
        }

        frameArrivedRevoker_ = pool_.FrameArrived(
            winrt::auto_revoke, {this, &WgcScreenCaptureSource::onFrameArrived});
        closedRevoker_ = item_.Closed(
            winrt::auto_revoke, {this, &WgcScreenCaptureSource::onItemClosed});

        session_.StartCapture();
        running_ = true;
        sourceId_ = sourceId;
        kind_ = description.kind;
        title_ = description.title;
        appName_ = description.appName;
        capturedFrames_.store(0u);
        frameErrorEmitted_ = false;
        lastError_.clear();
        emitHelperEvent("{\"type\":\"" +
                        std::string(kScreenCaptureStartedEvent) +
                        "\",\"kind\":\"" + jsonEscape(kind_) +
                        "\",\"width\":" + std::to_string(width_) +
                        ",\"height\":" + std::to_string(height_) +
                        ",\"fps\":" + std::to_string(options.fps) + "}");
      }

      watchdog->start();
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (running_ && sourceId_ == sourceId) {
          watchdog_ = std::move(watchdog);
        }
      }
      return true;
    } catch (const winrt::hresult_error &error) {
      handleStartError("wgc: " + hresultHex(winrtErrorCode(error)) + " " +
                       winrt::to_string(error.message()));
      stopInternal("user_stop", false);
      return false;
    } catch (const std::exception &error) {
      handleStartError(std::string("wgc: ") + error.what());
      stopInternal("user_stop", false);
      return false;
    }
  }

  bool presentPicker(const ScreenCaptureStartOptions &) override {
    setLastError("unsupported");
    return false;
  }

  void stop() override {
    try {
      WinRtApartment apartment;
    } catch (...) {
      // Shutdown still clears local state even if this thread cannot enter a
      // WinRT apartment; Close() failures are swallowed in stopInternal().
    }
    stopInternal("user_stop", isRunning());
  }

  bool isRunning() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return running_;
  }

  ScreenCaptureStatus status() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    ScreenCaptureStatus status;
    status.running = running_;
    status.sourceId = sourceId_;
    status.kind = kind_;
    status.title = title_;
    status.appName = appName_;
    status.width = width_;
    status.height = height_;
    status.capturedFrames = capturedFrames_.load();
    return status;
  }

  bool copyLatestFrame(VideoFrame &frame) override {
    return frames_.copyLatest(frame);
  }

  bool copyLatestFrameIfNew(uint64_t lastTimestampNs,
                            VideoFrame &frame) override {
    return frames_.copyIfNew(lastTimestampNs, frame);
  }

  bool takeLatestFrameIfNew(uint64_t lastTimestampNs,
                            VideoFrame &frame) override {
    return frames_.takeIfNew(lastTimestampNs, frame);
  }

  bool waitForFrameOrTimeout(
      uint64_t lastTimestampNs,
      std::chrono::steady_clock::time_point deadline) override {
    return frames_.waitForNewerThan(lastTimestampNs, deadline);
  }

  std::string lastError() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastError_;
  }

  std::string stickyLastError() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return stickyError_;
  }

  uint64_t stickyLastErrorAtMs() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return stickyErrorAtMs_;
  }

 private:
  capture::GraphicsCaptureItem createItemForWindow(HWND hwnd) {
    // WGC HWND/HMONITOR interop is available from Windows 10 1903 (18362).
    auto interop = winrt::get_activation_factory<capture::GraphicsCaptureItem,
                                                 IGraphicsCaptureItemInterop>();
    capture::GraphicsCaptureItem item{nullptr};
    winrt::check_hresult(interop->CreateForWindow(
        hwnd,
        // Same IID as the ABI IGraphicsCaptureItem; the projected type avoids
        // depending on the ABI header being pulled in transitively.
        winrt::guid_of<capture::GraphicsCaptureItem>(),
        winrt::put_abi(item)));
    return item;
  }

  capture::GraphicsCaptureItem createItemForMonitor(HMONITOR monitor) {
    // WGC HWND/HMONITOR interop is available from Windows 10 1903 (18362).
    auto interop = winrt::get_activation_factory<capture::GraphicsCaptureItem,
                                                 IGraphicsCaptureItemInterop>();
    capture::GraphicsCaptureItem item{nullptr};
    winrt::check_hresult(interop->CreateForMonitor(
        monitor,
        // Same IID as the ABI IGraphicsCaptureItem; the projected type avoids
        // depending on the ABI header being pulled in transitively.
        winrt::guid_of<capture::GraphicsCaptureItem>(),
        winrt::put_abi(item)));
    return item;
  }

  void ensureDeviceLocked() {
    if (device_ && context_ && winrtDevice_) {
      return;
    }
    device_.Reset();
    context_.Reset();
    winrtDevice_ = nullptr;

    const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    D3D_FEATURE_LEVEL featureLevel{};
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   flags, nullptr, 0, D3D11_SDK_VERSION,
                                   &device_, &featureLevel, &context_);
    if (FAILED(hr)) {
      hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
                             nullptr, 0, D3D11_SDK_VERSION, &device_,
                             &featureLevel, &context_);
    }
    winrt::check_hresult(hr);

    UINT formatSupport = 0u;
    mipAutogenSupported_ =
        SUCCEEDED(device_->CheckFormatSupport(DXGI_FORMAT_B8G8R8A8_UNORM,
                                              &formatSupport)) &&
        (formatSupport & D3D11_FORMAT_SUPPORT_MIP_AUTOGEN) != 0u;

    ComPtr<IDXGIDevice> dxgiDevice;
    winrt::check_hresult(device_.As(&dxgiDevice));

    foundation::IInspectable inspectable{nullptr};
    winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(
        dxgiDevice.Get(),
        reinterpret_cast<IInspectable **>(winrt::put_abi(inspectable))));
    winrtDevice_ = inspectable.as<direct3d11::IDirect3DDevice>();
  }

  void ensureStagingLocked(uint32_t width, uint32_t height) {
    if (staging_) {
      D3D11_TEXTURE2D_DESC existing{};
      staging_->GetDesc(&existing);
      if (existing.Width == width && existing.Height == height) {
        return;
      }
      staging_.Reset();
    }
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    winrt::check_hresult(device_->CreateTexture2D(&desc, nullptr, &staging_));
  }

  void ensureMipTextureLocked(uint32_t width, uint32_t height) {
    if (mipLevel_ == 0u) {
      mipSource_.Reset();
      mipSrv_.Reset();
      return;
    }
    if (mipSource_) {
      D3D11_TEXTURE2D_DESC existing{};
      mipSource_->GetDesc(&existing);
      if (existing.Width == width && existing.Height == height &&
          existing.MipLevels == mipLevel_ + 1u) {
        return;
      }
      mipSource_.Reset();
      mipSrv_.Reset();
    }

    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = mipLevel_ + 1u;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    desc.MiscFlags = D3D11_RESOURCE_MISC_GENERATE_MIPS;
    winrt::check_hresult(device_->CreateTexture2D(&desc, nullptr, &mipSource_));

    D3D11_SHADER_RESOURCE_VIEW_DESC srvDesc{};
    srvDesc.Format = desc.Format;
    srvDesc.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Texture2D.MostDetailedMip = 0;
    srvDesc.Texture2D.MipLevels = desc.MipLevels;
    winrt::check_hresult(
        device_->CreateShaderResourceView(mipSource_.Get(), &srvDesc, &mipSrv_));
  }

  void releaseTexturesLocked() {
    staging_.Reset();
    mipSource_.Reset();
    mipSrv_.Reset();
  }

  void onFrameArrived(const capture::Direct3D11CaptureFramePool &sender,
                      const foundation::IInspectable &) {
    try {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!running_) {
        return;
      }

      auto frame = sender.TryGetNextFrame();
      if (!frame) {
        return;
      }
      const auto size = frame.ContentSize();
      if (size.Width <= 0 || size.Height <= 0) {
        return;
      }
      if (size.Width != lastSize_.Width || size.Height != lastSize_.Height) {
        lastSize_ = size;
        mipLevel_ =
            mipAutogenSupported_
                ? selectCaptureMipLevel(static_cast<uint32_t>(size.Width),
                                        static_cast<uint32_t>(size.Height),
                                        options_.maxWidth, options_.maxHeight)
                : 0u;
        width_ = halvedDimension(static_cast<uint32_t>(size.Width), mipLevel_);
        height_ =
            halvedDimension(static_cast<uint32_t>(size.Height), mipLevel_);
        releaseTexturesLocked();
        sender.Recreate(winrtDevice_, kCaptureFormat, 2, size);
        return;
      }

      auto access =
          frame.Surface()
              .as<::Windows::Graphics::DirectX::Direct3D11::
                      IDirect3DDxgiInterfaceAccess>();
      ComPtr<ID3D11Texture2D> texture;
      winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(&texture)));

      const uint32_t srcW = static_cast<uint32_t>(size.Width);
      const uint32_t srcH = static_cast<uint32_t>(size.Height);
      const uint32_t outW = halvedDimension(srcW, mipLevel_);
      const uint32_t outH = halvedDimension(srcH, mipLevel_);
      ensureStagingLocked(outW, outH);
      ensureMipTextureLocked(srcW, srcH);

      D3D11_BOX box{};
      box.left = 0;
      box.top = 0;
      box.front = 0;
      box.right = srcW;
      box.bottom = srcH;
      box.back = 1;

      if (mipLevel_ == 0u) {
        context_->CopySubresourceRegion(staging_.Get(), 0, 0, 0, 0,
                                        texture.Get(), 0, &box);
      } else {
        context_->CopySubresourceRegion(mipSource_.Get(), 0, 0, 0, 0,
                                        texture.Get(), 0, &box);
        context_->GenerateMips(mipSrv_.Get());
        context_->CopySubresourceRegion(staging_.Get(), 0, 0, 0, 0,
                                        mipSource_.Get(), mipLevel_, nullptr);
      }

      const uint64_t mapStartNs = nowNs();
      D3D11_MAPPED_SUBRESOURCE mapped{};
      winrt::check_hresult(
          context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped));

      VideoFrame &scratch = frames_.scratch();
      scratch.width = outW;
      scratch.height = outH;
      swizzleBgraToRgba(static_cast<const uint8_t *>(mapped.pData),
                        static_cast<ptrdiff_t>(mapped.RowPitch), outW, outH,
                        scratch.rgba);
      context_->Unmap(staging_.Get(), 0);
      scratch.timestampNs = nowNs();
      scratch.captureQpc = nowQpc();
      const double mapSwizzleMs =
          static_cast<double>(scratch.timestampNs - mapStartNs) / 1000000.0;
      frames_.publish();

      const uint64_t frameCount = capturedFrames_.fetch_add(1u) + 1u;
      if (frameCount % 300u == 0u) {
        std::ostringstream event;
        event << "{\"type\":\"screen_capture_metrics\",\"map_swizzle_ms\":"
              << mapSwizzleMs << ",\"content_width\":" << srcW
              << ",\"content_height\":" << srcH
              << ",\"mip_level\":" << mipLevel_ << "}";
        emitHelperEvent(event.str());
      }
    } catch (const winrt::hresult_error &error) {
      handleFrameError("wgc: " + hresultHex(winrtErrorCode(error)) + " " +
                       winrt::to_string(error.message()));
    } catch (const std::exception &error) {
      handleFrameError(std::string("wgc: ") + error.what());
    }
  }

  void onItemClosed(const capture::GraphicsCaptureItem &,
                    const foundation::IInspectable &) {
    handleItemLost();
  }

  void handleItemLost() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      setStickyErrorLocked("item_closed");
    }
    stopInternal("item_closed", true);
  }

  void stopInternal(const char *reason, bool emit) {
    capture::GraphicsCaptureSession session{nullptr};
    capture::Direct3D11CaptureFramePool pool{nullptr};
    std::unique_ptr<LivenessWatchdog> watchdog;
    bool wasRunning = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      wasRunning = running_;
      watchdog = std::move(watchdog_);
      if (frameArrivedRevoker_) {
        frameArrivedRevoker_.revoke();
      }
      if (closedRevoker_) {
        closedRevoker_.revoke();
      }
      session = session_;
      pool = pool_;
      session_ = nullptr;
      pool_ = nullptr;
      item_ = nullptr;
      winrtDevice_ = nullptr;
      releaseTexturesLocked();
      running_ = false;
      sourceId_.clear();
      kind_.clear();
      title_.clear();
      appName_.clear();
      width_ = 0u;
      height_ = 0u;
      lastSize_ = {};
      mipLevel_ = 0u;
      cursorToggleSupported_ = false;
      frameErrorEmitted_ = false;
      capturedFrames_.store(0u);
    }
    if (watchdog) {
      watchdog->stop();
    }
    try {
      if (session) {
        session.Close();
      }
      if (pool) {
        pool.Close();
      }
    } catch (const winrt::hresult_error &error) {
      emitHelperEvent("{\"type\":\"screen_capture_close_error\",\"message\":\"" +
                      jsonEscape("wgc: " + hresultHex(winrtErrorCode(error)) +
                                 " " + winrt::to_string(error.message())) +
                      "\"}");
    }
    if (emit && wasRunning) {
      emitHelperEvent("{\"type\":\"" + std::string(kScreenCaptureStoppedEvent) +
                      "\",\"reason\":\"" + jsonEscape(reason) + "\"}");
    }
  }

  void setLastError(const std::string &error) {
    std::lock_guard<std::mutex> lock(mutex_);
    lastError_ = error;
  }

  void setStickyErrorLocked(const std::string &error) {
    stickyError_ = error;
    stickyErrorAtMs_ = nowNs() / 1000000ull;
  }

  void handleStartError(const std::string &message) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      lastError_ = "start_failed";
      setStickyErrorLocked(message);
    }
    emitHelperEvent("{\"type\":\"" + std::string(kScreenCaptureErrorEvent) +
                    "\",\"code\":\"screen_capture_start_failed\","
                    "\"message\":\"" +
                    jsonEscape(message) + "\"}");
  }

  void handleFrameError(const std::string &message) {
    bool shouldEmit = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      lastError_ = "frame_failed";
      setStickyErrorLocked(message);
      if (!frameErrorEmitted_) {
        frameErrorEmitted_ = true;
        shouldEmit = true;
      }
    }
    if (shouldEmit) {
      emitHelperEvent("{\"type\":\"" + std::string(kScreenCaptureErrorEvent) +
                      "\",\"code\":\"screen_capture_frame_failed\","
                      "\"message\":\"" +
                      jsonEscape(message) + "\"}");
    }
  }

  mutable std::mutex mutex_;
  GuardedFrameSlot frames_;
  int parentPid_ = 0;

  capture::GraphicsCaptureItem item_{nullptr};
  capture::Direct3D11CaptureFramePool pool_{nullptr};
  capture::GraphicsCaptureSession session_{nullptr};
  direct3d11::IDirect3DDevice winrtDevice_{nullptr};
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11Texture2D> staging_;
  ComPtr<ID3D11Texture2D> mipSource_;
  ComPtr<ID3D11ShaderResourceView> mipSrv_;
  winrt::Windows::Graphics::SizeInt32 lastSize_{};
  uint32_t mipLevel_ = 0u;
  capture::Direct3D11CaptureFramePool::FrameArrived_revoker
      frameArrivedRevoker_{};
  capture::GraphicsCaptureItem::Closed_revoker closedRevoker_{};
  std::unique_ptr<LivenessWatchdog> watchdog_;

  bool running_ = false;
  std::string sourceId_;
  std::string kind_;
  std::string title_;
  std::string appName_;
  uint32_t width_ = 0u;
  uint32_t height_ = 0u;
  std::atomic<uint64_t> capturedFrames_{0u};
  std::string lastError_;
  std::string stickyError_;
  uint64_t stickyErrorAtMs_ = 0u;
  ScreenCaptureStartOptions options_;
  bool cursorToggleSupported_ = false;
  bool mipAutogenSupported_ = false;
  bool frameErrorEmitted_ = false;
};

}  // namespace

std::unique_ptr<ScreenCaptureSource> createScreenCaptureSource(int parentPid) {
  return std::make_unique<WgcScreenCaptureSource>(parentPid);
}

}  // namespace broadify::meeting

#endif  // defined(_WIN32)
