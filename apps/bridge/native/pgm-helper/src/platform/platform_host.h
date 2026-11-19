#pragma once

#include <atomic>
#include <string>
#include <vector>

namespace broadify::pgm {

/**
 * What main.cpp needs from the operating system. One implementation per
 * platform (platform_host_mac.mm, platform_host_win.cpp); main.cpp itself
 * carries no platform conditionals.
 */

/** Process arguments as UTF-8, argv[0] included (Windows: from the wide command line). */
std::vector<std::string> processArgumentsUtf8(int argc, char **argv);

/** Interrupt/termination requests turn `running` false; `running` must outlive the process' threads. */
void installSignalHandlers(std::atomic<bool> &running);

/** stdout is piped to the bridge: make lifecycle events arrive line by line. */
void configureStdoutForEvents();

/** Per-process setup the capture and encoder backends need (macOS: accessory NSApplication; Windows: COM MTA + Media Foundation). */
void initializePlatform();

/**
 * Orphan watchdog: when the process `bridgePid` is gone, notes the exit reason
 * `parent_gone` and turns `running` false. Detached thread; no-op for pid <= 0.
 */
void startParentWatchdog(int bridgePid, std::atomic<bool> &running);

/** Blocks the main thread until `running` turns false (macOS: pumps the main run loop in 50 ms slices). */
void runPlatformLoop(std::atomic<bool> &running);

/** JSON value of the `encoder` field in the --probe line. */
std::string probeEncoderJson();

}  // namespace broadify::pgm
