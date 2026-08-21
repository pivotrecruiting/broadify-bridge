#pragma once

#include <cstdint>
#include <string>

#ifdef _WIN32
#include <dxgi1_6.h>
#include <wrl/client.h>
#endif

namespace broadify::meeting {

enum class D3DGpuPolicy {
  Auto,
  HighPerformance,
  MinimumPower,
};

struct D3DAdapterInfo {
  bool available = false;
  std::string policy = "auto";
  std::string description;
  int64_t luidHigh = 0;
  uint64_t luidLow = 0;
#ifdef _WIN32
  Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
#endif
};

D3DGpuPolicy parseD3DGpuPolicy(const char *value);
const char *d3dGpuPolicyName(D3DGpuPolicy policy);

#ifdef _WIN32
D3DAdapterInfo selectD3DAdapter();
const D3DAdapterInfo &sharedD3DAdapter();
std::string d3dAdapterStatusString(const D3DAdapterInfo &info);
#else
inline D3DAdapterInfo selectD3DAdapter() { return D3DAdapterInfo{}; }
inline const D3DAdapterInfo &sharedD3DAdapter() {
  static const D3DAdapterInfo info{};
  return info;
}
inline std::string d3dAdapterStatusString(const D3DAdapterInfo &) { return ""; }
#endif

}  // namespace broadify::meeting
