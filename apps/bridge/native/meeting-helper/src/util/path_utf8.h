#pragma once

// Implementation lives in helper-common (shared with the PGM helper); the
// meeting namespace re-exports it so call sites stay unchanged.
#include "helper_common/path_utf8.h"

namespace broadify::meeting {

using broadify::helper::fileExistsUtf8;
using broadify::helper::fopenUtf8;
using broadify::helper::openInputFileUtf8;
using broadify::helper::openOutputFileUtf8;
using broadify::helper::pathFromUtf8;
using broadify::helper::readFileBytesUtf8;
#if defined(_WIN32)
using broadify::helper::tryUtf8ToWide;
using broadify::helper::utf8ToWide;
using broadify::helper::wideToUtf8;
#endif

}  // namespace broadify::meeting
