#import <AppKit/AppKit.h>

#include "macos/macos_app.h"

namespace broadify::pgm {

void initializeMacosApplication() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  }
}

void runMacosApplicationLoop(std::atomic<bool> &running) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    while (running.load()) {
      @autoreleasepool {
        NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:0.05];
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:limit inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event != nil) {
          [NSApp sendEvent:event];
        }
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:limit];
      }
    }
  }
}

}  // namespace broadify::pgm
