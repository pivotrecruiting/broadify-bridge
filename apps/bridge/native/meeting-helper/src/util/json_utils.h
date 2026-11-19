#pragma once

// Implementation lives in helper-common (shared with the PGM helper); the
// meeting namespace re-exports it so call sites stay unchanged.
#include "helper_common/json_utils.h"

namespace broadify::meeting {

using broadify::helper::errorResponse;
using broadify::helper::extractBoolField;
using broadify::helper::extractDoubleField;
using broadify::helper::extractIntField;
using broadify::helper::extractObjectField;
using broadify::helper::extractStringArrayField;
using broadify::helper::extractStringField;
using broadify::helper::jsonEscape;
using broadify::helper::nowNs;
using broadify::helper::okResponse;

}  // namespace broadify::meeting
