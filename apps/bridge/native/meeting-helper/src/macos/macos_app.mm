#include "macos/macos_app.h"

#if defined(__APPLE__)

#import <AppKit/AppKit.h>

namespace broadify::meeting {

namespace {

NSWindow *g_promptWindow = nil;

}  // namespace

void initializeMacosApplication() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  }
}

void prepareMacosCameraPermissionPrompt() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    if (g_promptWindow == nil) {
      NSRect frame = NSMakeRect(-10000.0, -10000.0, 1.0, 1.0);
      g_promptWindow = [[NSWindow alloc] initWithContentRect:frame
                                                   styleMask:NSWindowStyleMaskBorderless
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
      [g_promptWindow setReleasedWhenClosed:NO];
      [g_promptWindow setCanHide:YES];
      [g_promptWindow setOpaque:NO];
      [g_promptWindow setAlphaValue:0.01];
    }
    [g_promptWindow orderFrontRegardless];
    [NSApp activateIgnoringOtherApps:YES];
  }
}

void runMacosApplicationLoop(std::atomic<bool> &running) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    while (running.load()) {
      @autoreleasepool {
        NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:0.05];
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                            untilDate:limit
                                               inMode:NSDefaultRunLoopMode
                                              dequeue:YES];
        if (event != nil) {
          [NSApp sendEvent:event];
        }
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:limit];
      }
    }
    if (g_promptWindow != nil) {
      [g_promptWindow orderOut:nil];
    }
  }
}

}  // namespace broadify::meeting

#endif
