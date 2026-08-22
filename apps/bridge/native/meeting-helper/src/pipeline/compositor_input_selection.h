#pragma once

namespace broadify::meeting {

enum class GovernorOffCompositorInput {
  LastMask,
  BackgroundOnly,
};

GovernorOffCompositorInput selectGovernorOffCompositorInput(bool hasLastGoodMask);

}  // namespace broadify::meeting
