; Registers the Windows virtual-camera media source with the system COM
; registry so the Windows Frame Server can load it ("Broadify Camera").
;
; Notes:
; - The NSIS installer itself is a 32-bit process; $WINDIR\Sysnative reaches
;   the native 64-bit regsvr32 (plain System32 would silently redirect to
;   SysWOW64 and register the CLSID under WOW6432Node, invisible to the
;   Frame Server).
; - regsvr32 writes to HKLM and therefore needs elevation: a per-machine
;   ("all users") install registers fine, a per-user install cannot - the
;   bridge then reports "is broadify-vcam.dll registered?" on vcam start.
; - Re-registering on every install/update keeps the CLSID pointing at the
;   current DLL path (a stale path is the documented classic failure).

!macro customInstall
  DetailPrint "Registering Broadify virtual camera (broadify-vcam.dll)"
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\native\vcam-helper\broadify-vcam.dll"' $0
  DetailPrint "regsvr32 exit code: $0"
!macroend

!macro customUnInstall
  DetailPrint "Unregistering Broadify virtual camera"
  ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\native\vcam-helper\broadify-vcam.dll"' $0
!macroend
