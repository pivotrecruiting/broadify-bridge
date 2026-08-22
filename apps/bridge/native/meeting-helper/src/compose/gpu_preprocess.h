#pragma once

#include "keyer/matting_common.h"

#include <cstdint>
#include <vector>

#ifdef _WIN32
#include "compose/gpu_context_win.h"
#include <d3d11_4.h>
#include <d3d12.h>
#include <wrl/client.h>
#include <wrl/wrappers/corewrappers.h>
#endif

namespace broadify::meeting {

struct TensorSampleMapping {
  uint32_t tensorIndex = 0;
  uint32_t channel = 0;
  uint32_t dstX = 0;
  uint32_t dstY = 0;
  double srcLeft = 0.0;
  double srcTop = 0.0;
  double srcRight = 0.0;
  double srcBottom = 0.0;
};

std::vector<TensorSampleMapping> buildGpuPreprocessMapping(
    uint32_t sourceWidth,
    uint32_t sourceHeight,
    const ModnetLetterboxMapping &letterbox);

#ifdef _WIN32
enum class GpuCameraFormat {
  Nv12,
  Yuy2,
};

struct GpuPreprocessSlot {
  Microsoft::WRL::ComPtr<ID3D11Buffer> d3d11Buffer;
  Microsoft::WRL::ComPtr<ID3D11UnorderedAccessView> uav;
  Microsoft::WRL::ComPtr<ID3D12Resource> d3d12Buffer;
  Microsoft::WRL::Wrappers::FileHandle sharedHandle;
  uint32_t tensorSize = 0;
};

class GpuPreprocessorWin {
 public:
  bool preprocess(ID3D11Texture2D *cameraTexture,
                  uint32_t subresource,
                  GpuCameraFormat format,
                  uint32_t sourceWidth,
                  uint32_t sourceHeight,
                  uint32_t tensorSize,
                  const ModnetLetterboxMapping &letterbox,
                  GpuFrameSlot slot);

  const GpuPreprocessSlot *slot(uint32_t index) const;

 private:
  bool ensureInitialized();
  bool ensureSlot(uint32_t index, uint32_t tensorSize);
  bool compileShader();

  bool initialized_ = false;
  bool available_ = false;
  Microsoft::WRL::ComPtr<ID3D11ComputeShader> shader_;
  Microsoft::WRL::ComPtr<ID3D11Buffer> uniforms_;
  GpuPreprocessSlot slots_[3];
};
#endif

}  // namespace broadify::meeting
