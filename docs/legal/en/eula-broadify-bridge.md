# End User License Agreement (EULA) — broadify Bridge

Version: August 24, 2026 · Document version 2.0 · Software reference version: broadify Bridge v0.25.2

> Binding-language notice: This English version is provided for information; the German version (`docs/legal/software-nutzungsbedingungen-eula-broadify-bridge.md`) is the governing text. All technical statements are derived from and verified against the source code of version v0.25.2. Items marked `[…]` (legal entity, governing law, venue, SLA) must be completed by management/legal review before publication.

## 1. Parties and Scope

1.1 This EULA governs the use of the installable desktop software **broadify Bridge**, including the local bridge component, native helper components (virtual camera, meeting/graphics/display helpers) and the relay connection for remote control (together, the "Software").

Provider/Licensor: **[LEGAL_ENTITY_NAME] · [ADDRESS] · [EMAIL_LEGAL]**

1.2 This EULA supplements the terms for the website, web application and billing. In case of conflict, this EULA prevails for the installed Software (order of precedence in Section 14).

## 2. Product Description and Product Lines

2.1 The Software is the local device component of the broadify product lines; the available scope of functions depends on the subscribed plan, assigned in the broadify web application:

- **broadifyStudio** — control of production hardware and graphics output: video switchers (Blackmagic ATEM via LAN and USB, vMix, NewTek TriCaster), graphics rendering with output via Blackmagic DeckLink hardware or connected displays, Elgato Stream Deck, camera presets (Canon XC), switchable power sockets (Shelly/Tasmota).
- **broadifyMeeting** — local camera processing for video conferencing: person segmentation (keying) performed entirely on the device, background and content compositing, delivery of the result as a virtual system camera ("Broadify Camera") to conferencing software (e.g., Microsoft Teams, Zoom), local MP4 recording.
- **broadifyConference** — conference-room functions: display output and automatic camera direction based on microphone-array data (supported: Shure, Sennheiser TCC2).

2.2 The Software accepts control commands that authorized users of the customer's organization submit via the broadify web application and the relay service (Section 5).

## 3. License Grant

3.1 The Licensor grants the user a simple, non-exclusive, non-transferable, revocable license to use the Software during the term of the underlying agreement in accordance with these terms. The number of permitted installations ("bridges") depends on the subscribed plan.

3.2 Permitted in particular: installation on contractually permitted devices, use for the customer's own business purposes according to plan, configuration of the bridge and connected systems.

3.3 Not permitted, except where mandated by law: sublicensing, resale or rental; circumvention of technical protection mechanisms; reverse engineering, decompilation or disassembly beyond statutory software-directive exceptions; use for unauthorized remote control of third-party systems; use in unlawful or abusive scenarios. Rights arising from the open-source licenses of bundled third-party components (Section 8) remain unaffected.

## 4. Installation, System Access and System Integration

4.1 The user acknowledges that the Software uses the following accesses, documented conclusively in the "Technical Annex" and the transparency document:

- local installation; on **Windows** machine-wide ("per machine", `C:\Program Files`) with administrator rights; the installer registers the virtual camera (COM component `broadify-vcam.dll`) with the Windows camera subsystem and removes the registration on uninstall;
- on **macOS**, a sandboxed CoreMediaIO system extension for the virtual camera (`com.broadify.vcam.extension`), whose activation requires explicit user approval in System Settings; camera and microphone access via macOS permission dialogs;
- local background and helper processes (bridge server, meeting/graphics/display helpers) that are strictly bound to the desktop app's lifecycle;
- network communication: local (loopback), optionally LAN as configured by the user, Internet exclusively for the relay, update checks, crash diagnostics and retrieval of customer-provided content (details: Privacy Notice);
- access to hardware/device metadata (displays, capture/DeckLink devices, cameras, microphones) for device discovery;
- local logging for operational, error and security purposes.

4.2 The Software installs **no autostart entry, no Windows service and no macOS LaunchAgent/Daemon**. All processes run only while the user has started the app and terminate with it; a watchdog terminates orphaned helper processes automatically.

## 5. Remote Control (Material Clause)

5.1 Remote control requires active pairing by the customer (pairing procedure with an 8-character random code, valid for 10 minutes, regenerated at every start of the Software). Without pairing and without the Software running, remote control is not possible.

5.2 The scope of remote control is technically limited to a fixed, versioned command list; every command is cryptographically signed (Ed25519), time-limited, replay-protected and schema-validated before execution. There is **no** command for executing arbitrary code, reading arbitrary files, or capturing the screen. The complete command list, the security architecture and the known limitations are disclosed in "Security and Remote Control Transparency — broadify Bridge".

5.3 Video and audio data do not leave the device via broadify infrastructure; keying, compositing, virtual camera and recording run entirely locally (see Privacy Notice, "Local Processing").

5.4 The user is responsible for securing accounts and devices (strong passwords, multi-factor authentication where offered, role/permission management within the organization) and for using remote functions only on systems for which the user is authorized. Abuse or suspected compromise must be reported without undue delay to: **[SECURITY_CONTACT_EMAIL]**.

## 6. User Obligations (Operation and Security)

The user shall in particular: operate the Software only in compatible, adequately secured environments; keep credentials and pairing codes confidential; secure local networks, devices and connected systems; observe updates and security notices; obtain any required consents for content and personal data processed through the Software. On multi-user systems with untrusted local users, deployment should be coordinated with the customer's IT security function (local trust model, see the transparency document).

## 7. Updates, Changes, Maintenance

7.1 The Software checks for updates after start and every six hours thereafter. The sole source is the signed releases of the repository `github.com/pivotrecruiting/broadify-bridge`. Download and installation occur **only after user confirmation** (no automatic download, no install-on-quit). Update checks can be disabled via the environment variable `BROADIFY_DISABLE_AUTO_UPDATE`.

7.2 Windows builds are signed via Azure Trusted Signing (Authenticode, RFC 3161 timestamp); macOS builds are Developer-ID signed, hardened (Hardened Runtime) and notarized by Apple. Update metadata contains SHA-512 checksums verified by the updater before installation.

7.3 The provider may change, extend or discontinue functions and adapt security measures within the contractually and legally permitted scope. A current version may be required for secure operation.

## 8. Third-Party Components and Open-Source Software

8.1 The Software contains or uses third-party components, in particular: Electron/Chromium (MIT), React (MIT), ONNX Runtime (MIT), Microsoft DirectML (proprietary redistributable terms, Windows only), Intel OpenVINO Runtime (Apache-2.0, Windows only), the MODNet segmentation model (Apache-2.0), pdf.js (Apache-2.0), stb_image (public domain/MIT), SDL2 (zlib, macOS only), LibreOffice as presentation renderer (MPL-2.0, macOS/arm64 only), integrations with Blackmagic hardware (compiled under the terms of the Blackmagic SDK), and further libraries under permissive licenses. The complete list including license texts is maintained in the Software's `NOTICES.md`.

8.2 Open-source components are governed primarily by their own licenses; this EULA does not restrict rights users derive from them. The Software contains no NDI SDK. Operating-system frameworks (Media Foundation, AVFoundation, CoreML, Vision) are used but not redistributed.

## 9. Data Processing and Privacy

The processing of personal data is described in the "Privacy Notice — broadify Bridge". Where the provider processes personal data on behalf of the customer, a data processing agreement (DPA) is available upon request: **[DPA reference]**.

## 10. Availability and Limits of Performance

The relay service is a cloud service; availability commitments arise exclusively from the main agreement or SLA **[reference]**. The local functions of the Software (keying, virtual camera, recording, LAN hardware control) operate independently of relay availability where no remote control is required. Functionality may otherwise depend on third-party devices, network configuration and platform services; uninterrupted availability is owed only where expressly agreed.

## 11. Liability (to be finalized by legal review)

11.1 The provider is liable in accordance with statutory provisions for intent and gross negligence and for injury to life, body or health, and under product liability law.

11.2 In all other respects, liability is — to the extent legally permissible — limited to the breach of material contractual obligations and to the foreseeable damage typical for the contract. **[B2B/B2C differentiation, liability caps and exclusions (consequential damages, lost profit, production/broadcast failures caused by misconfiguration, compromised user accounts, third-party devices) to be drafted by counsel.]**

11.3 The user is responsible for the proper configuration and authorization of remotely controllable functions. The provider is not liable for damage resulting from unauthorized use on the user's side, provided the provider has complied with the contractually owed security measures and is not itself at fault.

## 12. Suspension

The provider may suspend access to remote services in whole or in part where a security incident or abuse is suspected, material breaches exist, or suspension is required to avert danger or to comply with legal obligations. Where possible, the user is informed in advance, otherwise without undue delay. The local functions of the installed Software remain technically unaffected by a relay suspension.

## 13. Term, Termination, Consequences

The term follows the underlying agreement. Upon termination, the right of use ends; the customer uninstalls the Software and may remove the pairing of its bridges in the web application. Locally stored data (recordings, logs, caches) remains on the user's device and under the user's responsibility.

## 14. Order of Precedence

In case of conflict: 1. individual agreement/offer/order form · 2. service description/SLA · 3. this EULA · 4. website/web-app terms · 5. other policies. The transparency documents (Privacy Notice, Security and Remote Control Transparency, Technical Annex) are informational and do not create performance obligations beyond the agreement.

## 15. Export and Compliance

The user warrants not to use the Software in violation of applicable export-control, sanctions or embargo regulations.

## 16. Governing Law, Venue (to be finalized by legal review)

Governing law: **[JURISDICTION_LAW]**. Venue (B2B): **[COURT]**. Mandatory consumer-protection provisions remain unaffected. The governing contract language is German.

---

*References: Privacy Notice — broadify Bridge · Security and Remote Control Transparency — broadify Bridge · Technical Annex (connection mechanisms, system access, local storage) · NOTICES.md.*
