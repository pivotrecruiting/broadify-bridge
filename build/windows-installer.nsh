; Registers the Windows virtual-camera media source with the system COM
; registry so the Windows Frame Server can load it ("Broadify Camera").
;
; Notes:
; - The NSIS installer itself is a 32-bit process; $WINDIR\Sysnative reaches
;   the native 64-bit regsvr32 (plain System32 would silently redirect to
;   SysWOW64 and register the CLSID under WOW6432Node, invisible to the
;   Frame Server).
; - regsvr32 writes to HKLM and therefore needs elevation. The installer is
;   built per-machine (electron-builder.json nsis.perMachine), so it always
;   runs elevated; should registration still fail, the exit code is reported
;   (details pane, error level 3, message box in interactive mode) instead of
;   silently shipping a dead camera. The install itself is never aborted.
; - Re-registering on every install/update keeps the CLSID pointing at the
;   current DLL path (a stale path is the documented classic failure).
; - On uninstall the DLL is already deleted when customUnInstall runs
;   (electron-builder removes $INSTDIR first), so regsvr32 /u cannot work;
;   the CLSID key is removed directly instead.
; - The Windows Camera Frame Server can keep the DLL loaded across updates.
;   The installer asks FrameServer/FrameServerMonitor to stop before
;   registration. If Windows refuses, install continues and a reboot is the
;   supported fallback so the new DLL is loaded on next camera use.

; Must match apps/bridge/native/vcam-helper/windows/vcam_guid.h.
!define BROADIFY_VCAM_CLSID "{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}"
!define BROADIFY_VCAM_CLSID_KEY "Software\Classes\CLSID\${BROADIFY_VCAM_CLSID}"
!define BROADIFY_VCAM_DLL "$INSTDIR\resources\native\vcam-helper\broadify-vcam.dll"

!macro customInstall
  SetRegView 64
  DetailPrint "Stopping Windows Camera Frame Server services before VCam refresh"
  ExecWait '"$WINDIR\Sysnative\sc.exe" stop FrameServer' $0
  DetailPrint "FrameServer stop exit code: $0"
  ExecWait '"$WINDIR\Sysnative\sc.exe" stop FrameServerMonitor' $1
  DetailPrint "FrameServerMonitor stop exit code: $1"
  ${If} $0 != 0
  ${AndIf} $0 != 1062
    DetailPrint "FrameServer could not be stopped; reboot may be required for broadify-vcam.dll replacement to take effect."
  ${EndIf}
  ${If} $1 != 0
  ${AndIf} $1 != 1062
    DetailPrint "FrameServerMonitor could not be stopped; reboot may be required for broadify-vcam.dll replacement to take effect."
  ${EndIf}
  DetailPrint "Registering Broadify virtual camera (broadify-vcam.dll)"
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "${BROADIFY_VCAM_DLL}"' $0
  DetailPrint "regsvr32 exit code: $0"
  ${If} $0 != 0
    DetailPrint "Broadify virtual camera registration FAILED (regsvr32 exit code $0). The app stays usable; the virtual camera needs a manual registration by an administrator."
    SetErrorLevel 3
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The Broadify virtual camera could not be registered (regsvr32 exit code $0).$\r$\n$\r$\nThe application was installed, but the virtual camera will not be available until an administrator runs:$\r$\n$\r$\nregsvr32 $\"${BROADIFY_VCAM_DLL}$\""
    ${EndIf}
  ${EndIf}
  SetRegView lastused
!macroend

!macro customUnInstall
  SetRegView 64
  DetailPrint "Unregistering Broadify virtual camera (removing HKLM\${BROADIFY_VCAM_CLSID_KEY})"
  DeleteRegKey HKLM "${BROADIFY_VCAM_CLSID_KEY}"
  SetRegView lastused
!macroend
