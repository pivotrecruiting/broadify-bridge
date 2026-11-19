#pragma once

// Implementation lives in helper-common (shared with the PGM helper); the
// meeting namespace re-exports it so call sites stay unchanged.
#include "helper_common/helper_event_log.h"

namespace broadify::meeting {

using broadify::helper::emitHelperEvent;
using broadify::helper::helperExitReason;
using broadify::helper::noteHelperExitReason;
using broadify::helper::setHelperEventLogPath;

}  // namespace broadify::meeting
