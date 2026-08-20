/*
  ATEM USB Helper (macOS)

  Bridges the official Blackmagic ATEM Switchers SDK for USB-attached
  switchers. All SDK calls live in this helper process so that SDK crashes
  or blocking calls can never take down the bridge (same doctrine as the
  DeckLink helper).

  Modes:
    --probe : connect via USB only (empty device address per SDK manual),
              print a single JSON status object to stdout and exit.

  The SDK runtime is loaded at runtime by BMDSwitcherAPIDispatch from
  /Library/Application Support/Blackmagic Design/Switchers/. When the ATEM
  software is not installed, the probe reports sdk_available=false instead
  of failing to launch.
*/

#include <BMDSwitcherAPI.h>
#include <CoreFoundation/CoreFoundation.h>

#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

namespace {

std::string cfStringToStdString(CFStringRef cfString) {
  if (!cfString) {
    return "";
  }
  CFIndex length = CFStringGetLength(cfString);
  CFIndex maxSize =
      CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string result(maxSize, '\0');
  if (CFStringGetCString(cfString, result.data(), maxSize, kCFStringEncodingUTF8)) {
    result.resize(std::strlen(result.c_str()));
    return result;
  }
  return "";
}

std::string jsonEscape(const std::string &value) {
  std::ostringstream out;
  for (char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          out << "\\u" << std::hex << static_cast<int>(c);
        } else {
          out << c;
        }
    }
  }
  return out.str();
}

// Maps the SDK's four-char connect failure codes onto stable helper error
// identifiers consumed by the bridge adapter.
std::string connectFailureToError(BMDSwitcherConnectToFailure reason) {
  switch (reason) {
    case bmdSwitcherConnectToFailureNoResponse:
      return "no_usb_switcher_found";
    case bmdSwitcherConnectToFailureIncompatibleFirmware:
      return "incompatible_firmware";
    case bmdSwitcherConnectToFailureCorruptData:
      return "corrupt_data";
    case bmdSwitcherConnectToFailureStateSync:
      return "state_sync_failed";
    case bmdSwitcherConnectToFailureStateSyncTimedOut:
      return "state_sync_timed_out";
    default:
      return "connect_failed";
  }
}

int runProbe() {
  IBMDSwitcherDiscovery *discovery = CreateBMDSwitcherDiscoveryInstance();
  if (discovery == nullptr) {
    // ATEM software (and with it the SDK runtime bundle) is not installed.
    std::cout << "{\"mode\":\"probe\",\"sdk_available\":false,\"connected\":false,"
              << "\"error\":\"atem_software_not_installed\"}" << std::endl;
    return 0;
  }

  IBMDSwitcher *switcher = nullptr;
  BMDSwitcherConnectToFailure failReason = bmdSwitcherConnectToFailureNoResponse;
  // Empty device address = USB-only connect (ATEM SDK manual, ConnectTo).
  HRESULT result = discovery->ConnectTo(CFSTR(""), &switcher, &failReason);
  if (result != S_OK || switcher == nullptr) {
    std::cout << "{\"mode\":\"probe\",\"sdk_available\":true,\"connected\":false,"
              << "\"error\":\"" << connectFailureToError(failReason) << "\"}"
              << std::endl;
    discovery->Release();
    return 0;
  }

  std::string productName;
  CFStringRef productNameRef = nullptr;
  if (switcher->GetProductName(&productNameRef) == S_OK && productNameRef) {
    productName = cfStringToStdString(productNameRef);
    CFRelease(productNameRef);
  }

  // Count populated macro slots as a cheap end-to-end proof that the macro
  // pool is reachable over USB (the bridge adapter's core capability).
  uint32_t macroSlots = 0;
  uint32_t validMacros = 0;
  IBMDSwitcherMacroPool *macroPool = nullptr;
  if (switcher->QueryInterface(IID_IBMDSwitcherMacroPool,
                               reinterpret_cast<void **>(&macroPool)) == S_OK &&
      macroPool != nullptr) {
    macroPool->GetMaxCount(&macroSlots);
    for (uint32_t i = 0; i < macroSlots; ++i) {
      bool valid = false;
      if (macroPool->IsValid(i, &valid) == S_OK && valid) {
        ++validMacros;
      }
    }
    macroPool->Release();
  }

  std::cout << "{\"mode\":\"probe\",\"sdk_available\":true,\"connected\":true,"
            << "\"product_name\":\"" << jsonEscape(productName) << "\","
            << "\"macro_slots\":" << macroSlots << ","
            << "\"valid_macros\":" << validMacros << "}" << std::endl;

  switcher->Release();
  discovery->Release();
  return 0;
}

void printUsage() {
  std::cerr << "Usage: atem-usb-helper --probe" << std::endl;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc >= 2 && std::strcmp(argv[1], "--probe") == 0) {
    return runProbe();
  }
  printUsage();
  return 2;
}
