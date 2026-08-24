# Security and Remote Control Transparency — broadify Bridge

Version: August 24, 2026 · Document version 2.0 · Software reference version: broadify Bridge v0.25.2

> This document addresses customers' IT, security and privacy teams. Every statement is derived from the source code of version v0.25.2; Appendix B provides pointers for independent verification. It replaces neither the EULA nor a DPA nor the Privacy Notice. The German version (`docs/legal/security-und-remote-control-transparenz.md`) is the governing text.

## 1. Architecture in One Paragraph

The broadify Bridge desktop app runs on the customer's machine. It starts a local bridge process and — depending on function — native helpers (meeting processing, graphics renderer, display/DeckLink output, virtual camera). For remote control, the bridge establishes **a single outbound** WebSocket connection (WSS) to the broadify relay; it opens **no** Internet-reachable port. Authorized users of the customer's organization send commands via the web app to the relay, which delivers them to the bridge. Video and audio are processed exclusively on the device and never leave it via broadify infrastructure (see Privacy Notice, Section 3).

## 2. What a Remote Actor Can Do at Most — and What It Cannot

### 2.1 Exhaustive Command List

The bridge executes only commands from a fixed, versioned list compiled into the software (v0.25.2: 79 commands). Unknown commands are rejected. Groups and maximum effect:

| Group | Commands | Maximum effect |
| --- | --- | --- |
| Status/pairing | `get_status`, `bridge_pair_validate`, `list_outputs` | read status; validate a pairing code; enumerate local output devices |
| Video switchers ("engine") | `engine_connect`, `engine_disconnect`, `engine_get_status`, `engine_get_macros`, `engine_run_macro`, `engine_stop_macro`, `engine_vmix_run_action` (script start/stop only), `engine_vmix_ensure_browser_input` | connect/disconnect a user-specified switcher (ATEM/vMix/TriCaster) on the LAN or via USB; run/stop predefined macros/scripts |
| Graphics | `graphics_configure_outputs`, `graphics_send`, `graphics_update_values`, `graphics_update_layout`, `graphics_remove`, `graphics_remove_preset`, `graphics_test_pattern`, `graphics_list` | hand graphics templates to the local renderer (HTML/CSS passes a sanitizer: no scripts, no external URLs) and output via configured outputs |
| Meeting | camera (`meeting_camera_*`: list/select/start/stop/open_set/program_select/pip_set/audio_levels/auto_director), keyer (`meeting_keyer_*`), program/output (`meeting_program_*`, `meeting_output_configure`, virtual camera start/stop), recording (`meeting_recording_*`), content (`meeting_background_image_fetch`, `meeting_media_*`), `meeting_call_control` | control local camera processing; start/stop recording to a local MP4 file (path validated, `.mp4` only); fetch customer-provided content via HTTPS (safeguards see 2.3); trigger predefined conferencing-app actions such as mute (fixed action list, no free input) |
| Conference | `conference_display_*`, `conference_director_*` | control display output and microphone-array camera direction |
| Peripherals | `streamdeck_*`, `power_socket_*`, `canon_xc_*` | configure Stream Deck; trigger stored power-socket URLs; recall camera presets |

### 2.2 What Does Not Exist (verified negative list)

- **No arbitrary code execution:** there is no shell/exec command; every process launch in the software uses fixed binaries with fixed arguments; no command input ever reaches a shell.
- **No arbitrary file access:** writes are confined to the app data directory and validated recording paths (`.mp4`, absolute, no `..`); no command returns file contents of the device to the web app; logs are not remotely retrievable.
- **No screen capture:** no screen-capture command exists; the software transmits no image data to broadify (not even preview thumbnails).
- **No listening from the Internet:** all of the software's servers bind to 127.0.0.1 (loopback); the only Internet connections are the outbound relay connection plus update checks, crash diagnostics and HTTPS content retrieval.
- **No operation without the user:** no autostart, no system service, no daemon. All processes end when the app quits (orphaned processes terminate themselves). A closed app cannot receive commands.

### 2.3 Retrieval of Customer Content (the only remotely triggered downloads)

`meeting_background_image_fetch` / `meeting_media_fetch` download customer-uploaded content via short-lived signed URLs. Safeguards: HTTPS on port 443 only, no embedded credentials, no IP literals, DNS resolution is validated against private/local address ranges (SSRF/DNS-rebinding protection), no redirects, size and time limits, file-signature format checks (images ≤ 8 MB; PDF/PPTX ≤ 100 MB). Disclosed limitation: there is no host allowlist — any public HTTPS host is reachable within these limits.

## 3. Cryptographic Protection of Remote Control

1. **User → web app:** sign-in to the customer account; every command request passes server-side authorization: organization membership, the "control devices" role permission (the "viewer" role can never send commands), plan/mode gating (fail-closed), and verification that the target bridge belongs to the organization.
2. **Web app → relay:** the web app signs each request server-side (Ed25519 "caller assertion" carrying user, organization, role, target bridge, command and payload hash; validity 30 seconds).
3. **Relay → bridge:** every delivered command carries an Ed25519 signature with metadata (target bridge, per-command scope, issue/expiry ±60 s, one-time ID). The bridge verifies signature, target, scope and freshness, enforces replay protection (one-time-ID cache) and a 2-MB message cap. Only then is the payload validated against strict schemas and executed.
4. **Bridge → relay:** the bridge authenticates with a locally generated Ed25519 device key (challenge–response); the private key never leaves the device (file mode 0600). Pairing registers only the public key.
5. **Pairing:** an 8-character random code, valid for 10 minutes, regenerated at every start, memory-only; without successful pairing the bridge is not assigned to any organization.

Transport: WSS/HTTPS with certificate validation against the system trust store (no additional pinning). The application-layer Ed25519 signatures protect commands independently of the transport.

## 4. Local Trust Model (relevant for multi-user systems)

The software's local interfaces follow the model "same machine = trusted":

- Local control API (default `127.0.0.1:8787`): restricted to loopback; browser access is limited by an origin allowlist (app.broadify.de plus local development origins) and a Host-header check (DNS-rebinding protection); non-loopback access requires a configured token (constant-time comparison) and is denied without one.
- The preview stream (MJPEG) and the virtual-camera frame stream (port 18787) are loopback-bound but carry **no additional authentication**: any process on the same machine can read them. The graphics-renderer channel is additionally token-protected.
- Windows: the virtual camera's shared-memory ring carries an explicit ACL (SDDL); read/write access is granted to the Windows camera service (LOCAL SERVICE) and signed-in local users. macOS: shared memory with mode 0600; the camera system extension is sandboxed and can only read the local stream.

**Recommendation:** on systems with untrusted local users (terminal servers, shared workstations), coordinate deployment with IT security.

## 5. Application Hardening

- Electron: `contextIsolation: true`, `nodeIntegration: false`, sandbox enabled; renderers have no Node access; a narrow, validated preload interface (fixed method list, sender validation); external links open http/https only via the system browser.
- Graphics templates (HTML/CSS from the web app) pass a sanitizer: no scripts, no event handlers, no iframes/objects, no external resources; only registered local assets.
- Updates: signed releases only (Windows: Azure Trusted Signing/Authenticode; macOS: Developer ID + notarization + Hardened Runtime), SHA-512-verified, installed only after user confirmation. Release authority lies with repository access holding the CI signing secrets.
- Native access: camera/microphone only via operating-system permission dialogs; the macOS camera extension requires explicit user activation in System Settings.

## 6. Customer Control

- **Off means off:** quitting the app ends all processes and the relay connection; there is no background service.
- Bridge start/stop and network binding are controlled in the app; pairing can be removed organization-side in the web app.
- Update checks can be disabled (`BROADIFY_DISABLE_AUTO_UPDATE`).
- Local logs are viewable and deletable in the app (`logs/bridge.log`, `logs/app.log` in the app data directory; Windows camera component: `%ProgramData%\Broadify\vcam.log`).

## 7. Logging and Known Limitations (honest disclosure)

We disclose the currently known limitations so customers can assess them:

1. **Command audit:** in production builds, execution of individual remote commands is logged locally at debug level only; the default log contains connection/error events but no complete command history. A complete local audit of "which user executed which command when" is not available in v0.25.2. *(Planned improvement: an info-level audit line per command.)*
2. **Preview/camera streams locally unauthenticated:** loopback-bound but not authenticated against other processes of the same user (Section 4).
3. **Content retrieval without a host allowlist** (Section 2.3).
4. **Power-socket URLs:** customer-stored switching URLs are called verbatim via HTTP(S) when triggered (by design, for LAN smart plugs); customers are responsible for not storing sensitive URLs there.
5. **Status data contains operational metadata** (device names, the configured LAN switcher IP, installation paths), visible only to authorized users of the customer's own organization.
6. **No certificate pinning** to the relay (system trust store; compensated by end-to-end command signatures).
7. Local logs contain the computer name (logging-library default); they do not leave the device.

## 8. Vulnerability Reporting

Please report security findings to **[SECURITY_CONTACT_EMAIL]**. **[Reference responsible-disclosure policy/PGP key.]**

---

## Appendix A — Data Flows at a Glance

| Flow | Direction | Content | Protection |
| --- | --- | --- | --- |
| Bridge → relay | outbound, WSS | hello (bridge ID, name, version), status/event JSON, command results | TLS, Ed25519 device key |
| Relay → bridge | via existing WSS | signed commands (allowlist) | Ed25519 signature, scope, TTL, replay protection, 2-MB cap, schema validation |
| Bridge → customer storage | outbound, HTTPS | retrieval of signed content URLs | SSRF guard, limits, format checks |
| Desktop app → Sentry (EU) | outbound, HTTPS | crash/error diagnostics (no user account, no computer name, no screenshots) | TLS |
| Desktop app → GitHub | outbound, HTTPS | update metadata/installers (signed) | TLS, signature/hash verification |
| Video/audio | **never leaves the device** (local: shared memory, loopback) | — | loopback binding, OS access controls |

## Appendix B — Verification Pointers for Customer IT

- Source code: `github.com/pivotrecruiting/broadify-bridge` (public); key files include `apps/bridge/src/services/relay-command-allowlist.ts` (command list), `relay-command-security.ts` (signature/replay verification), `apps/bridge/src/services/meeting/media-download.ts` (download guard), `apps/bridge/src/routes/route-guards.ts` (local API protection).
- Network verification: after app start, `lsof -nP -iTCP -a -p <PID>` (macOS) or `netstat -ano` (Windows) shows only loopback listeners and the single outbound WSS connection.
- Process verification: after quitting the app, no broadify processes remain; no autostart entries/services exist.
- Signature verification: Windows `Get-AuthenticodeSignature`; macOS `codesign --verify` / `spctl --assess` against the installed app.
