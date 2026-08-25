/*
  Minimal Blackmagic Switcher COM surface for interoperability.
  GUID values are from the vendor IDLs; no vendor text is copied here.
*/

#pragma once

#if !defined(_WIN32)
#error bmd_switcher_interop_win.h is Windows-only.
#endif

#include <unknwn.h>
#include <windows.h>

struct IBMDSwitcher_v97;
struct IBMDSwitcher_v100;
struct IBMDSwitcher_v104;
struct IBMDSwitcherCallback;
struct IBMDSwitcherMacro;
struct IBMDSwitcherMacroControlCallback;
struct IBMDSwitcherMacroPoolCallback;
struct IBMDSwitcherTransferMacro;

inline constexpr CLSID CLSID_CBMDSwitcherDiscovery_v97 = {
    0xB8C0BA7E, 0xBDED, 0x4B73, {0x96, 0xA8, 0x26, 0x6A, 0xF1, 0xBC, 0x2D, 0x7A}};
inline constexpr CLSID CLSID_CBMDSwitcherDiscovery_v100 = {
    0x8A13D4FA, 0x4801, 0x48E3, {0xBF, 0x68, 0x44, 0x2D, 0x63, 0xE3, 0x45, 0x00}};
inline constexpr CLSID CLSID_CBMDSwitcherDiscovery_v104 = {
    0xA9CDC765, 0x3787, 0x409D, {0xA1, 0xE5, 0x29, 0xF4, 0xF0, 0x34, 0xA5, 0x99}};

inline constexpr IID IID_IBMDSwitcherDiscovery_v97 = {
    0x83C30ED4, 0x4314, 0x4C81, {0xB1, 0xE3, 0x23, 0xC5, 0x18, 0xD6, 0xD8, 0xBD}};
inline constexpr IID IID_IBMDSwitcherDiscovery_v100 = {
    0x1EEE089A, 0x5422, 0x4A76, {0xB0, 0x68, 0xF6, 0xED, 0xCF, 0xBD, 0x3A, 0xC0}};
inline constexpr IID IID_IBMDSwitcherDiscovery_v104 = {
    0x28449053, 0xAC7A, 0x49EB, {0xAC, 0xD2, 0xD1, 0xE0, 0xC5, 0x7D, 0xC6, 0x27}};
inline constexpr IID IID_IBMDSwitcherCallback = {
    0xEE50FC2C, 0xD0D7, 0x42D6, {0x96, 0x5A, 0x57, 0x49, 0x8C, 0xEC, 0xC1, 0xF6}};
inline constexpr IID IID_IBMDSwitcherMacroPool = {
    0x5FA28BFC, 0x7934, 0x42F4, {0xBE, 0xD8, 0x87, 0x44, 0xD6, 0x2D, 0x21, 0x0F}};
inline constexpr IID IID_IBMDSwitcherMacroPoolCallback = {
    0xE29294A0, 0xFB4C, 0x418D, {0x9A, 0xE1, 0xC6, 0xCB, 0xA2, 0x88, 0x10, 0x4F}};
inline constexpr IID IID_IBMDSwitcherMacroControl = {
    0x2E23E657, 0xA7F0, 0x4C4A, {0xBC, 0xBE, 0x4B, 0x8D, 0x3D, 0xD0, 0x61, 0xAC}};
inline constexpr IID IID_IBMDSwitcherMacroControlCallback = {
    0xF6A62317, 0x60F6, 0x4D5C, {0xA5, 0xDD, 0x2D, 0xC3, 0x72, 0xB9, 0xF4, 0xFF}};
inline constexpr IID IID_IBMDSwitcherTransferMacro = {
    0x9BAD28DB, 0xF0CC, 0x4696, {0x82, 0xEE, 0xB1, 0xE3, 0xE5, 0xA7, 0xC1, 0x29}};

using BMDSwitcherVideoMode = unsigned int;
using BMDSwitcherDownConversionMethod = unsigned int;
using BMDSwitcher3GSDIOutputLevel = unsigned int;
using BMDSwitcherColorimetryMode = unsigned int;
using BMDSwitcherPowerStatus = unsigned int;
using BMDSwitcherTimeCodeMode = unsigned int;
using BMDSwitcherMacroPoolEventType = unsigned int;
using BMDSwitcherMacroRecordStatus = unsigned int;

enum BMDSwitcherConnectToFailure {
  bmdSwitcherConnectToFailureNoResponse = 0x63666E72,
  bmdSwitcherConnectToFailureIncompatibleFirmware = 0x63666966,
  bmdSwitcherConnectToFailureCorruptData = 0x63666364,
  bmdSwitcherConnectToFailureStateSync = 0x63667373,
  bmdSwitcherConnectToFailureStateSyncTimedOut = 0x63667374,
  bmdSwitcherConnectToFailureDeprecatedAfter_v7_3 = 0x63666430,
};

enum BMDSwitcherEventType {
  bmdSwitcherEventTypeVideoModeChanged = 0x73657664,
  bmdSwitcherEventTypeMethodForDownConvertedSDChanged = 0x73656D64,
  bmdSwitcherEventTypeDownConvertedHDVideoModeChanged = 0x73656456,
  bmdSwitcherEventTypeMultiViewVideoModeChanged = 0x73656D76,
  bmdSwitcherEventTypePowerStatusChanged = 0x73657077,
  bmdSwitcherEventTypeDisconnected = 0x73656469,
  bmdSwitcherEventType3GSDIOutputLevelChanged = 0x73653367,
  bmdSwitcherEventTypeColorimetryModeChanged = 0x636F6C6D,
  bmdSwitcherEventTypeTimeCodeChanged = 0x73657463,
  bmdSwitcherEventTypeTimeCodeLockedChanged = 0x74636C63,
  bmdSwitcherEventTypeTimeCodeExternalChanged = 0x74636578,
  bmdSwitcherEventTypeTimeCodeModeChanged = 0x74636D63,
  bmdSwitcherEventTypeSuperSourceCascadeChanged = 0x73736363,
  bmdSwitcherEventTypeAutoVideoModeChanged = 0x6169766D,
  bmdSwitcherEventTypeAutoVideoModeDetectedChanged = 0x61766D64,
  bmdSwitcherEventTypeFadeToBlackEnabledChanged = 0x66626543,
  bmdSwitcherEventTypeDskTallyOverrideEnabledChanged = 0x6F746543,
};

enum BMDSwitcherMacroRunStatus {
  bmdSwitcherMacroRunStatusIdle = 0x00,
  bmdSwitcherMacroRunStatusRunning = 0x01,
  bmdSwitcherMacroRunStatusWaitingForUser = 0x02,
};

enum BMDSwitcherMacroControlEventType {
  bmdSwitcherMacroControlEventTypeRunStatusChanged = 0x6D61726E,
  bmdSwitcherMacroControlEventTypeRecordStatusChanged = 0x6D617263,
};

struct IBMDSwitcherDiscovery : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE ConnectTo(BSTR deviceAddress, void **switcherDevice,
                                              BMDSwitcherConnectToFailure *failReason) = 0;
};

// IBMDSwitcher 9.7: 44 methods.
struct IBMDSwitcher_v97 : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetProductName(BSTR *productName) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetVideoMode(BMDSwitcherVideoMode *videoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetVideoMode(BMDSwitcherVideoMode videoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportVideoMode(BMDSwitcherVideoMode videoMode, BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesVideoModeChangeRequireReconfiguration(BMDSwitcherVideoMode videoMode,
                                                                             BOOL *required) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMethodForDownConvertedSD(BMDSwitcherDownConversionMethod *method) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetMethodForDownConvertedSD(BMDSwitcherDownConversionMethod method) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                               BMDSwitcherVideoMode *downConvertedHDVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                               BMDSwitcherVideoMode downConvertedHDVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                                       BMDSwitcherVideoMode downConvertedHDVideoMode,
                                                                       BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                         BMDSwitcherVideoMode *multiviewVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                         BMDSwitcherVideoMode multiviewVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                                 BMDSwitcherVideoMode multiviewVideoMode,
                                                                 BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE Get3GSDIOutputLevel(BMDSwitcher3GSDIOutputLevel *outputLevel) = 0;
  virtual HRESULT STDMETHODCALLTYPE Set3GSDIOutputLevel(BMDSwitcher3GSDIOutputLevel outputLevel) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportColorimetrySetting(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetColorimetryMode(BMDSwitcherColorimetryMode *colorimetry) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetColorimetryMode(BMDSwitcherColorimetryMode colorimetry) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetPowerStatus(BMDSwitcherPowerStatus *powerStatus) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCode(unsigned char *hours, unsigned char *minutes, unsigned char *seconds,
                                               unsigned char *frames, BOOL *dropFrame) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetTimeCode(unsigned char hours, unsigned char minutes, unsigned char seconds,
                                               unsigned char frames) = 0;
  virtual HRESULT STDMETHODCALLTYPE RequestTimeCode(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeLocked(BOOL *timeCodeLocked) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeExternal(BOOL *timeCodeExternal) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeMode(BMDSwitcherTimeCodeMode *timeCodeMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetTimeCodeMode(BMDSwitcherTimeCodeMode timeCodeMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAreOutputsConfigurable(BOOL *configurable) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetSuperSourceCascade(BOOL *cascade) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetSuperSourceCascade(BOOL cascade) = 0;
  virtual HRESULT STDMETHODCALLTYPE SuspendStreaming(unsigned int durationMs) = 0;
  virtual HRESULT STDMETHODCALLTYPE AllowStreamingToResume(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportAutoVideoMode(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAutoVideoMode(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAutoVideoModeDetected(BOOL *detected) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetAutoVideoMode(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportFadeToBlackEnabledSetting(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetFadeToBlackEnabled(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetFadeToBlackEnabled(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportDskTallyOverride(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDskTallyOverrideEnabled(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDskTallyOverrideEnabled(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE CreateIterator(REFIID iid, LPVOID *ppv) = 0;
  virtual HRESULT STDMETHODCALLTYPE AddCallback(IBMDSwitcherCallback *callback) = 0;
  virtual HRESULT STDMETHODCALLTYPE RemoveCallback(IBMDSwitcherCallback *callback) = 0;
};

// IBMDSwitcher 10.0: 45 methods.
struct IBMDSwitcher_v100 : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetProductName(BSTR *productName) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetVideoMode(BMDSwitcherVideoMode *videoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetVideoMode(BMDSwitcherVideoMode videoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportVideoMode(BMDSwitcherVideoMode videoMode, BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesVideoModeChangeRequireReconfiguration(BMDSwitcherVideoMode videoMode,
                                                                             BOOL *required) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMethodForDownConvertedSD(BMDSwitcherDownConversionMethod *method) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetMethodForDownConvertedSD(BMDSwitcherDownConversionMethod method) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                               BMDSwitcherVideoMode *downConvertedHDVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                               BMDSwitcherVideoMode downConvertedHDVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                                       BMDSwitcherVideoMode downConvertedHDVideoMode,
                                                                       BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                         BMDSwitcherVideoMode *multiviewVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                         BMDSwitcherVideoMode multiviewVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                                 BMDSwitcherVideoMode multiviewVideoMode,
                                                                 BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE Get3GSDIOutputLevel(BMDSwitcher3GSDIOutputLevel *outputLevel) = 0;
  virtual HRESULT STDMETHODCALLTYPE Set3GSDIOutputLevel(BMDSwitcher3GSDIOutputLevel outputLevel) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportColorimetrySetting(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetColorimetryMode(BMDSwitcherColorimetryMode *colorimetry) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetColorimetryMode(BMDSwitcherColorimetryMode colorimetry) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetPowerStatus(BMDSwitcherPowerStatus *powerStatus) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCode(unsigned char *hours, unsigned char *minutes, unsigned char *seconds,
                                               unsigned char *frames, BOOL *dropFrame) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetTimeCode(unsigned char hours, unsigned char minutes, unsigned char seconds,
                                               unsigned char frames) = 0;
  virtual HRESULT STDMETHODCALLTYPE RequestTimeCode(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeLocked(BOOL *timeCodeLocked) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeExternal(BOOL *timeCodeExternal) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeMode(BMDSwitcherTimeCodeMode *timeCodeMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetTimeCodeMode(BMDSwitcherTimeCodeMode timeCodeMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAreOutputsConfigurable(BOOL *configurable) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetSuperSourceCascade(BOOL *cascade) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetSuperSourceCascade(BOOL cascade) = 0;
  virtual HRESULT STDMETHODCALLTYPE SuspendStreaming(unsigned int durationMs) = 0;
  virtual HRESULT STDMETHODCALLTYPE AllowStreamingToResume(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportAutoVideoMode(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAutoVideoMode(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAutoVideoModeDetected(BOOL *detected) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetAutoVideoMode(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportFadeToBlackEnabledSetting(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetFadeToBlackEnabled(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetFadeToBlackEnabled(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportDskTallyOverride(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDskTallyOverrideEnabled(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDskTallyOverrideEnabled(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportTallyConfig(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE CreateIterator(REFIID iid, LPVOID *ppv) = 0;
  virtual HRESULT STDMETHODCALLTYPE AddCallback(IBMDSwitcherCallback *callback) = 0;
  virtual HRESULT STDMETHODCALLTYPE RemoveCallback(IBMDSwitcherCallback *callback) = 0;
};

// IBMDSwitcher 10.4: 51 methods.
struct IBMDSwitcher_v104 : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetProductName(BSTR *productName) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetVideoMode(BMDSwitcherVideoMode *videoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetVideoMode(BMDSwitcherVideoMode videoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportVideoMode(BMDSwitcherVideoMode videoMode, BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesVideoModeChangeRequireReconfiguration(BMDSwitcherVideoMode videoMode,
                                                                             BOOL *required) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMethodForDownConvertedSD(BMDSwitcherDownConversionMethod *method) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetMethodForDownConvertedSD(BMDSwitcherDownConversionMethod method) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                               BMDSwitcherVideoMode *downConvertedHDVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                               BMDSwitcherVideoMode downConvertedHDVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportDownConvertedHDVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                                       BMDSwitcherVideoMode downConvertedHDVideoMode,
                                                                       BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                         BMDSwitcherVideoMode *multiviewVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                         BMDSwitcherVideoMode multiviewVideoMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportMultiViewVideoMode(BMDSwitcherVideoMode coreVideoMode,
                                                                 BMDSwitcherVideoMode multiviewVideoMode,
                                                                 BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE Get3GSDIOutputLevel(BMDSwitcher3GSDIOutputLevel *outputLevel) = 0;
  virtual HRESULT STDMETHODCALLTYPE Set3GSDIOutputLevel(BMDSwitcher3GSDIOutputLevel outputLevel) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportColorimetrySetting(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetColorimetryMode(BMDSwitcherColorimetryMode *colorimetry) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetColorimetryMode(BMDSwitcherColorimetryMode colorimetry) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetPowerStatus(BMDSwitcherPowerStatus *powerStatus) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCode(unsigned char *hours, unsigned char *minutes, unsigned char *seconds,
                                               unsigned char *frames, BOOL *dropFrame) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetTimeCode(unsigned char hours, unsigned char minutes, unsigned char seconds,
                                               unsigned char frames) = 0;
  virtual HRESULT STDMETHODCALLTYPE RequestTimeCode(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeLocked(BOOL *timeCodeLocked) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeExternal(BOOL *timeCodeExternal) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimeCodeMode(BMDSwitcherTimeCodeMode *timeCodeMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetTimeCodeMode(BMDSwitcherTimeCodeMode timeCodeMode) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportTimecodeSdiOutputEnabledSetting(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTimecodeSdiOutputEnabled(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetTimecodeSdiOutputEnabled(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAreOutputsConfigurable(BOOL *configurable) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetSuperSourceCascade(BOOL *cascade) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetSuperSourceCascade(BOOL cascade) = 0;
  virtual HRESULT STDMETHODCALLTYPE SuspendStreaming(unsigned int durationMs) = 0;
  virtual HRESULT STDMETHODCALLTYPE AllowStreamingToResume(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportAutoVideoMode(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAutoVideoMode(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAutoVideoModeDetected(BOOL *detected) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetAutoVideoMode(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportFadeToBlackEnabledSetting(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetFadeToBlackEnabled(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetFadeToBlackEnabled(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportDskTallyOverride(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDskTallyOverrideEnabled(BOOL *enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDskTallyOverrideEnabled(BOOL enabled) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportTallyConfig(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE DoesSupportExternalAudioControl(BOOL *supported) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetExternalAudioControlActive(BOOL *active) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetExternalAudioControlActive(BOOL active) = 0;
  virtual HRESULT STDMETHODCALLTYPE CreateIterator(REFIID iid, LPVOID *ppv) = 0;
  virtual HRESULT STDMETHODCALLTYPE AddCallback(IBMDSwitcherCallback *callback) = 0;
  virtual HRESULT STDMETHODCALLTYPE RemoveCallback(IBMDSwitcherCallback *callback) = 0;
};

struct IBMDSwitcherCallback : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE Notify(BMDSwitcherEventType eventType,
                                           BMDSwitcherVideoMode coreVideoMode) = 0;
};

struct IBMDSwitcherMacroPool : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetMaxCount(unsigned int *maxCount) = 0;
  virtual HRESULT STDMETHODCALLTYPE Delete(unsigned int index) = 0;
  virtual HRESULT STDMETHODCALLTYPE IsValid(unsigned int index, BOOL *valid) = 0;
  virtual HRESULT STDMETHODCALLTYPE HasUnsupportedOps(unsigned int index, BOOL *hasUnsupportedOps) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetName(unsigned int index, BSTR *name) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetName(unsigned int index, BSTR name) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDescription(unsigned int index, BSTR *description) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDescription(unsigned int index, BSTR description) = 0;
  virtual HRESULT STDMETHODCALLTYPE CreateMacro(unsigned int sizeBytes, IBMDSwitcherMacro **macro) = 0;
  virtual HRESULT STDMETHODCALLTYPE Upload(unsigned int index, BSTR name, BSTR description, IBMDSwitcherMacro *macro,
                                          IBMDSwitcherTransferMacro **macroTransfer) = 0;
  virtual HRESULT STDMETHODCALLTYPE Download(unsigned int index, IBMDSwitcherTransferMacro **macroTransfer) = 0;
  virtual HRESULT STDMETHODCALLTYPE AddCallback(IBMDSwitcherMacroPoolCallback *callback) = 0;
  virtual HRESULT STDMETHODCALLTYPE RemoveCallback(IBMDSwitcherMacroPoolCallback *callback) = 0;
};

struct IBMDSwitcherMacroPoolCallback : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE Notify(BMDSwitcherMacroPoolEventType eventType, unsigned int index,
                                           IBMDSwitcherTransferMacro *macroTransfer) = 0;
};

struct IBMDSwitcherMacroControl : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE Run(unsigned int index) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetLoop(BOOL *loop) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetLoop(BOOL loop) = 0;
  virtual HRESULT STDMETHODCALLTYPE ResumeRunning(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE StopRunning(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE Record(unsigned int index, BSTR name, BSTR description) = 0;
  virtual HRESULT STDMETHODCALLTYPE RecordUserWait(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE RecordPause(unsigned int frames) = 0;
  virtual HRESULT STDMETHODCALLTYPE StopRecording(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetRunStatus(BMDSwitcherMacroRunStatus *status, BOOL *loop, unsigned int *index) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetRecordStatus(BMDSwitcherMacroRecordStatus *status, unsigned int *index) = 0;
  virtual HRESULT STDMETHODCALLTYPE AddCallback(IBMDSwitcherMacroControlCallback *callback) = 0;
  virtual HRESULT STDMETHODCALLTYPE RemoveCallback(IBMDSwitcherMacroControlCallback *callback) = 0;
};

struct IBMDSwitcherMacroControlCallback : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE Notify(BMDSwitcherMacroControlEventType eventType) = 0;
};

struct IBMDSwitcherTransferMacro : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE Cancel(void) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetProgress(double *progress) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetMacro(IBMDSwitcherMacro **macro) = 0;
};
