#pragma once

#include <atomic>

namespace broadify::meeting {

void initializeMacosApplication();
void runMacosApplicationLoop(std::atomic<bool> &running);
void prepareMacosCameraPermissionPrompt();

}  // namespace broadify::meeting
