#include "compose/d3d_adapter_select.h"

#include <iostream>

using broadify::meeting::D3DGpuPolicy;
using broadify::meeting::parseD3DGpuPolicy;

namespace {

bool expect(bool condition, const char *what) {
  if (!condition) {
    std::cerr << "d3d_adapter_select_test failed: " << what << std::endl;
  }
  return condition;
}

}  // namespace

int main() {
  bool ok = true;
  ok &= expect(parseD3DGpuPolicy(nullptr) == D3DGpuPolicy::Auto, "null -> auto");
  ok &= expect(parseD3DGpuPolicy("") == D3DGpuPolicy::Auto, "empty -> auto");
  ok &= expect(parseD3DGpuPolicy("auto") == D3DGpuPolicy::Auto, "auto -> auto");
  ok &= expect(parseD3DGpuPolicy("high_performance") == D3DGpuPolicy::HighPerformance,
               "high_performance");
  ok &= expect(parseD3DGpuPolicy("minimum-power") == D3DGpuPolicy::MinimumPower,
               "minimum-power");
  ok &= expect(parseD3DGpuPolicy("split") == D3DGpuPolicy::Split,
               "split");
  ok &= expect(parseD3DGpuPolicy("garbage") == D3DGpuPolicy::Auto, "invalid -> auto");
  return ok ? 0 : 1;
}
