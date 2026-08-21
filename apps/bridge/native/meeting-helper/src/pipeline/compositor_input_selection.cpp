#include "pipeline/compositor_input_selection.h"

namespace broadify::meeting {

GovernorOffCompositorInput selectGovernorOffCompositorInput(bool hasLastGoodMask) {
  return hasLastGoodMask ? GovernorOffCompositorInput::LastMask
                         : GovernorOffCompositorInput::BackgroundOnly;
}

}  // namespace broadify::meeting
