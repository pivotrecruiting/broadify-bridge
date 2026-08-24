# Privacy Notice — broadify Bridge (Web App, Bridge, Relay)

Version: August 24, 2026 · Document version 2.0 · Software reference version: broadify Bridge v0.25.2

> All technical statements are derived from and verified against the source code of version v0.25.2; storage locations and transfer paths are documented with source references in the "Technical Annex". Items marked `[…]` must be completed before publication. The German version (`docs/legal/datenschutzerklaerung-desktop-app-und-relay.md`) is the governing text.

## 1. Scope

This notice describes the processing of personal data when using the desktop software **broadify Bridge** (product lines broadifyStudio, broadifyMeeting, broadifyConference), the associated **web application** (app.broadify.de) and the **relay service** that conveys control commands between the web app and the installed software. It supplements the privacy notices for the website, web-app account/billing and payment processing.

## 2. Controller

Controller (Art. 4(7) GDPR): **[LEGAL_ENTITY_NAME] · [ADDRESS] · [EMAIL_PRIVACY]** · Data protection contact/DPO: **[DPO_CONTACT]**

In productive B2B use, broadify regularly processes content and operational data **on behalf of the customer** (Art. 28 GDPR); a data processing agreement is available: **[DPA reference]**. For account, license, billing and security processes, broadify acts as controller.

## 3. Guiding Principle: Local Processing of Video and Audio

The Software's core processing takes place **entirely on the device**:

- Camera capture, person segmentation (AI keying with locally bundled models), background/content compositing and delivery as a virtual camera run exclusively locally. The native processing component has **no outbound network connections whatsoever**; its interfaces are bound to the local machine (loopback or local shared memory).
- Recordings are stored **locally** as MP4 files (default: the user's "Movies"/"Videos" folder, or a user-selected path). No code path exists that transmits recordings, camera images or audio to broadify.
- Video, audio and image data do **not** leave the device via broadify infrastructure. The relay carries exclusively JSON control and status messages.

## 4. Categories of Data, Purposes, Legal Bases

### 4.1 Account and Organization Data (web app)

User account, roles/permissions, organization membership, plan/license status. Purpose: contract performance, access control. Legal basis: Art. 6(1)(b) GDPR. Details in the web app's privacy notice.

### 4.2 Device and Connection Data (bridge/relay)

- **Bridge ID**: a locally generated random UUID (no hardware derivation); **bridge name**: freely chosen by the user; **app version**, protocol version and a session UUID. These are transmitted to the relay upon connection. The Software transmits **no computer name (hostname), no OS usernames and no hardware serial numbers** to the relay.
- **Connection records**: start/end of the relay connection per bridge (table `relay_bridge_sessions`: bridge ID, session, region, timestamps). Purpose: operation, deliverability, security. Legal basis: Art. 6(1)(b), (f) GDPR.
- **Organization assignment**: bridge ↔ organization mapping, "last seen" timestamps and last version (`bridges`, `organization_bridges`); the bridge's public key (`bridge_enrollment_keys`). The private key never leaves the device (file mode 0600).

### 4.3 Control Commands and Status Data (relay)

- Every command by a web-app user is signed server-side and carries as metadata the **user UUID, organization UUID, role, target bridge, command type and a payload hash** (validity 30 seconds). Purpose: authorization and traceability of remote control. Legal basis: Art. 6(1)(b), (f) GDPR.
- Command envelopes (including payload — e.g., graphics texts, device names, the LAN IP of a video switcher configured by the user) are held **transiently for delivery** in the relay database (`relay_pending_commands`). **[Insert the concrete deletion period from relay operations — retention policy.]**
- Status messages from the bridge may, depending on function, contain: device display names (cameras, output devices), the user-configured target IP/port of a LAN video switcher, installation paths of software components and — when the save dialog is used — the user-selected recording path. Visible only to authorized users of the customer's own organization.

### 4.4 Content Data (processed on behalf of the customer)

- **Graphics templates and dynamic values** (e.g., lower-third texts containing names) are maintained by the customer in the web app and delivered to the bridge via the relay; responsibility for the content lies with the customer.
- **Meeting presentations (PDF/PPTX)** are uploaded by the user to a private storage bucket (max. 100 MB, format-verified) and retrieved by the bridge via short-lived signed URLs (validity 1 hour); files are **automatically deleted server-side after 24 hours** (hourly cleanup job). **Background images/logos** reside in a private bucket (max. 5 MB, image formats only). Bridge-side retrieval is HTTPS-only with technical safeguards (size/time limits, blocking of private network addresses).

### 4.5 Crash and Error Diagnostics (Sentry)

The desktop app transmits crash and error reports to **Sentry** (Functional Software, Inc.), configured for **EU ingest**. Transmitted: technical error data (error message, stack trace, app version, OS metadata, screen resolution); **no user-account data is attached, no screenshots are transmitted, and no computer name is sent** (the software sets no server name). The bridge server process and native helpers contain no Sentry. Purpose: stability and defect resolution. Legal basis: Art. 6(1)(f) GDPR. **[Optional: document an opt-out once available in the product; transmission is currently not user-disableable.]**

### 4.6 Update Checks (GitHub)

The Software checks for updates against the public releases of `github.com/pivotrecruiting/broadify-bridge` (GitHub, Inc.). No account or device identifiers of the Software are sent; the usual technical access data of an HTTPS request (IP address) applies at GitHub. Download/installation only after user confirmation; checks can be disabled via environment variable.

### 4.7 Local Logs (on the device)

Bridge and app logs are stored locally (app data directory, `logs/bridge.log` with 5-MB rotation and a limited file count; Windows camera component: `%ProgramData%\Broadify\vcam.log`). Logs contain technical operational data and — due to the logging library's defaults — the local computer name; they **remain on the device** (no command or interface exports logs to broadify) and can be viewed and deleted by the user in the app. Command payloads are not written to production logs.

### 4.8 No Advertising/Analytics Trackers

The desktop software contains **no** analytics, tracking or advertising SDKs (verified; the only external diagnostic tool is Sentry per 4.5).

## 5. Recipients and Processors

| Recipient | Service | Data categories | Location/Transfer |
| --- | --- | --- | --- |
| Fly.io, Inc. | Relay hosting | connection, command and status data (4.2, 4.3) | **[document region/SCCs]** |
| Supabase, Inc. | Database, auth, file storage of the web app | account/organization data, device registration, content uploads (4.1, 4.2, 4.4) | **[document region/SCCs]** |
| Vercel, Inc. | Web-app hosting | web-app access data | **[document region/SCCs]** |
| Functional Software, Inc. (Sentry) | Crash/error diagnostics | technical error data (4.5) | EU ingest; **[SCC/TIA]** |
| GitHub, Inc. (Microsoft) | Delivery of signed updates | technical access data (4.6) | USA; **[SCCs]** |
| Stripe | Payment processing | see web-app/payment privacy notices | — |

Internal access follows need-to-know (support, operations, security). **[Maintain the complete subprocessor list with countries and transfer mechanisms.]**

## 6. Retention

- Pairing codes: memory-only, max. 10 minutes or until the Software restarts.
- Signed content URLs: 1 hour.
- Meeting presentation files (transfer bucket): automatic deletion after 24 hours.
- Command envelopes at the relay: transient for delivery; **[insert binding period]**.
- Relay connection records, device registration: for the duration of the organization assignment or **[insert period]**.
- Sentry error data: per project configuration **[insert period; default 90 days]**.
- Local logs: rolling retention on the device (5-MB rotation, limited file count); deletable by the user at any time.
- Local recordings, caches and configurations: remain on the device until deleted by the user.

## 7. Data Subject Rights

Data subjects have, where applicable, the rights of access, rectification, erasure, restriction, data portability and objection, and the right to lodge a complaint with a supervisory authority. Requests: **[EMAIL_PRIVACY]**. Where broadify processes data on behalf of a customer, requests are answered in coordination with the customer as controller; contractual arrangements (DPA) prevail.

## 8. Obligation to Provide Data

Device, connection and security metadata (4.2, 4.3) are technically required to provide pairing and remote control securely; without them these functions cannot be used. The purely local functions of the Software require no transmission to broadify.

## 9. Changes

This notice is updated when functions, processing operations, service providers or legal requirements change. The published version applies; material changes are documented with version and software reference.

---

*References: Security and Remote Control Transparency — broadify Bridge (complete command list, security architecture) · Technical Annex (connection mechanisms, system access, local storage with source-code references) · EULA — broadify Bridge.*
