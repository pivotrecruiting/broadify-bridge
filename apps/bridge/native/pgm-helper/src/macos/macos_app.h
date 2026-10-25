#pragma once

#include <atomic>

namespace broadify::pgm {

/** NSApplication as an accessory app: needed for AVFoundation notifications and the TCC prompt attribution. */
void initializeMacosApplication();
/** Pumps the main run loop until `running` turns false (50 ms slices). */
void runMacosApplicationLoop(std::atomic<bool> &running);

}  // namespace broadify::pgm
