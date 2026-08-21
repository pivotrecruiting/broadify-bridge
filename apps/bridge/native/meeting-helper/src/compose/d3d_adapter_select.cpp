#include "compose/d3d_adapter_select.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <iostream>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <dxgi1_6.h>
#endif

namespace broadify::meeting {
namespace {

std::string lowerAscii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

#ifdef _WIN32
std::string wideToUtf8(const wchar_t *value) {
  if (value == nullptr || value[0] == L'\0') {
    return std::string();
  }
  const int needed = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (needed <= 0) {
    return std::string();
  }
  std::string result(static_cast<size_t>(needed), '\0');
  const int written = WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), needed, nullptr, nullptr);
  if (written <= 0) {
    return std::string();
  }
  if (!result.empty() && result.back() == '\0') {
    result.pop_back();
  }
  return result;
}

bool isSoftwareAdapter(const DXGI_ADAPTER_DESC1 &desc) {
  return (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;
}

std::vector<D3DAdapterInfo> enumerateAdapters(IDXGIFactory6 *factory,
                                              DXGI_GPU_PREFERENCE preference,
                                              const char *policy) {
  std::vector<D3DAdapterInfo> adapters;
  for (UINT index = 0;; ++index) {
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    HRESULT hr = factory->EnumAdapterByGpuPreference(
        index, preference, IID_PPV_ARGS(&adapter));
    if (hr == DXGI_ERROR_NOT_FOUND) {
      break;
    }
    if (FAILED(hr)) {
      break;
    }
    DXGI_ADAPTER_DESC1 desc{};
    if (FAILED(adapter->GetDesc1(&desc)) || isSoftwareAdapter(desc)) {
      continue;
    }
    D3DAdapterInfo info;
    info.available = true;
    info.policy = policy;
    info.description = wideToUtf8(desc.Description);
    info.luidHigh = static_cast<int64_t>(desc.AdapterLuid.HighPart);
    info.luidLow = static_cast<uint64_t>(static_cast<uint32_t>(desc.AdapterLuid.LowPart));
    info.adapter = adapter;
    adapters.push_back(std::move(info));
  }
  return adapters;
}

void logSelectedAdapter(const D3DAdapterInfo &info) {
  static bool logged = false;
  if (logged || !info.available) {
    return;
  }
  logged = true;
  std::cout << "{\"type\":\"gpu_adapter_selected\",\"backend\":\"d3d\","
            << "\"policy\":\"" << info.policy << "\",\"description\":\""
            << info.description << "\",\"luid_high\":" << info.luidHigh
            << ",\"luid_low\":" << info.luidLow << "}" << std::endl;
}
#endif

}  // namespace

D3DGpuPolicy parseD3DGpuPolicy(const char *value) {
  if (value == nullptr || value[0] == '\0') {
    return D3DGpuPolicy::Auto;
  }
  const std::string normalized = lowerAscii(value);
  if (normalized == "high_performance" || normalized == "high-performance" ||
      normalized == "performance") {
    return D3DGpuPolicy::HighPerformance;
  }
  if (normalized == "minimum_power" || normalized == "minimum-power" ||
      normalized == "power_saving") {
    return D3DGpuPolicy::MinimumPower;
  }
  return D3DGpuPolicy::Auto;
}

const char *d3dGpuPolicyName(D3DGpuPolicy policy) {
  switch (policy) {
    case D3DGpuPolicy::HighPerformance:
      return "high_performance";
    case D3DGpuPolicy::MinimumPower:
      return "minimum_power";
    case D3DGpuPolicy::Auto:
    default:
      return "auto";
  }
}

#ifdef _WIN32
D3DAdapterInfo selectD3DAdapter() {
  Microsoft::WRL::ComPtr<IDXGIFactory6> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    return D3DAdapterInfo{};
  }

  const D3DGpuPolicy policy =
      parseD3DGpuPolicy(std::getenv("BROADIFY_MEETING_GPU_POLICY"));
  const char *policyName = d3dGpuPolicyName(policy);
  const DXGI_GPU_PREFERENCE preference =
      policy == D3DGpuPolicy::MinimumPower
          ? DXGI_GPU_PREFERENCE_MINIMUM_POWER
          : DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE;

  std::vector<D3DAdapterInfo> adapters = enumerateAdapters(factory.Get(), preference, policyName);
  if (adapters.empty() && policy == D3DGpuPolicy::MinimumPower) {
    adapters = enumerateAdapters(factory.Get(), DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, policyName);
  }
  if (adapters.empty()) {
    return D3DAdapterInfo{};
  }
  logSelectedAdapter(adapters.front());
  return adapters.front();
}

const D3DAdapterInfo &sharedD3DAdapter() {
  static const D3DAdapterInfo info = selectD3DAdapter();
  return info;
}

std::string d3dAdapterStatusString(const D3DAdapterInfo &info) {
  if (!info.available) {
    return std::string();
  }
  return info.description + " luid=" + std::to_string(info.luidHigh) + ":" +
         std::to_string(info.luidLow);
}
#endif

}  // namespace broadify::meeting
