#pragma once

#include <string>

namespace broadify::meeting {

// Sets the sidecar file that mirrors every helper JSON event (empty disables
// mirroring). The file is truncated on set - one file per helper run.
void setHelperEventLogPath(const std::string &path);

// Emits one JSON event line to stdout AND appends it to the sidecar file.
// On macOS the bridge launches the helper through /usr/bin/open, which
// swallows stdio - the sidecar file is the only channel that survives, and
// the bridge dumps its tail into the process log when the helper dies.
void emitHelperEvent(const std::string &jsonLine);

// Records why the helper is about to exit deliberately (e.g.
// "control_shutdown"); read back by the main teardown for the final
// shutdown event. Last writer wins.
void noteHelperExitReason(const std::string &reason);

// The recorded exit reason, or an empty string when none was noted.
std::string helperExitReason();

}  // namespace broadify::meeting
