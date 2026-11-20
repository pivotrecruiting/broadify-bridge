# Third-Party Notices

This file contains attributions and notices for third-party software used in this application.

## NewTek NDI (if used)

This application may use NDI (Network Device Interface) for video streaming.

**Provider:** NewTek (Vizrt)

**License:** Proprietary (commercial license required)

**Website:** https://www.ndi.tv/

**Note:** Commercial use of NDI requires a license from NewTek.

---

## Electron

This application is built with Electron.

**License:** MIT

**Website:** https://www.electronjs.org/

**Source Code:** https://github.com/electron/electron

---

## React

This application uses React for the user interface.

**License:** MIT

**Website:** https://react.dev/

**Source Code:** https://github.com/facebook/react

---

## MODNet

This application uses the MODNet portrait matting model (including converted
ONNX and Core ML runtime artifacts derived from the upstream pretrained
weights) in the Meeting Helper keyer.

**Copyright:** Copyright (c) Zhanghan Ke and MODNet contributors

**License:** Apache License 2.0

**License Text:** https://www.apache.org/licenses/LICENSE-2.0

**Source Code:** https://github.com/ZHKKKe/MODNet

Upstream states that the code, models, and demos in that repository (excluding
GIF files under `doc/gif`) are released under Apache License 2.0. Apache 2.0
permits commercial use, modification, and redistribution subject to the license
terms (including attribution and retention of copyright/license notices).

---

## ONNX Runtime

The Windows Meeting Helper uses Microsoft ONNX Runtime for MODNet inference.

**Copyright:** Copyright (c) Microsoft Corporation

**License:** MIT

**Source Code:** https://github.com/microsoft/onnxruntime

ONNX Runtime redistributions may include additional third-party components.
See the `ThirdPartyNotices.txt` shipped with the ONNX Runtime package for those
attributions.

---

## DirectML

The Windows Meeting Helper redistributes `DirectML.dll` (Microsoft.AI.DirectML)
as part of the application for GPU-accelerated ONNX Runtime inference.

**Provider:** Microsoft Corporation

**License:** Microsoft software license terms for Microsoft.AI.DirectML
(proprietary redistributable; not MIT)

**Source / Package:** https://www.nuget.org/packages/Microsoft.AI.DirectML/

**Project:** https://github.com/microsoft/DirectML

Redistribution is permitted only as part of applications or services you
develop for Windows (and Xbox where applicable), subject to the Microsoft
DirectML license terms. DirectML must not be provided as a stand-alone offering.

---

## Apple Vision Framework

On macOS, the Meeting Helper may use Apple Vision person segmentation
(`VNGeneratePersonSegmentationRequest`) as a keyer fallback or as an
explicitly selected model. Vision is a system framework provided by Apple; no
separate model binary is redistributed with this application.

**Provider:** Apple Inc.

**Terms:** Apple Developer Program License Agreement / platform SDK terms

**Documentation:** https://developer.apple.com/documentation/vision

---

## LibreOffice

This application bundles an unmodified LibreOffice runtime and runs it
headless to convert PowerPoint files (PPTX) to PDF for Meeting content.

**Provider:** The Document Foundation

**License:** Mozilla Public License 2.0 (MPL-2.0)

**License Text:** https://www.mozilla.org/MPL/2.0/

**Website:** https://www.libreoffice.org/

**Source Code:** https://www.libreoffice.org/about-us/source-code/

**Bundled version:** macOS (arm64) ships the release pinned in
`apps/bridge/vendor/presentation-runtime/manifest.json` (currently 26.2.4).
Windows (x64) ships LibreOffice only when the release build is configured with
a pinned archive (`PRESENTATION_RUNTIME_URL_WIN` /
`PRESENTATION_RUNTIME_SHA256_WIN`, see
`docs/bridge/windows-libreoffice-bundle.md`); the version is the one of that
archive.

LibreOffice includes third-party components under their own licenses. The
license and notice files shipped by The Document Foundation are retained
inside the bundled runtime (`presentation-runtime/` in the application
resources). "LibreOffice" is a trademark of The Document Foundation; its use
here does not imply endorsement.

---

## OpenSSL

The live program preview (PGM Helper and Meeting Helper) links OpenSSL 3
statically for the DTLS/SRTP transport of its WebRTC stream. On macOS the
library comes from Homebrew `openssl@3`; the Windows build prepared behind
`BROADIFY_PGM_WINDOWS=1` takes it from vcpkg
(`apps/bridge/native/live-stream/vcpkg.json`).

**Copyright:** Copyright (c) 1998-2026 The OpenSSL Project Authors.
Copyright (c) 1995-1998 Eric A. Young, Tim J. Hudson. All rights reserved.

**License:** Apache License 2.0

**License Text:** https://www.apache.org/licenses/LICENSE-2.0

**Source Code:** https://github.com/openssl/openssl

---

## libdatachannel

The live program preview uses libdatachannel (statically linked, unmodified,
release v0.22.6) as its WebRTC implementation.

**Copyright:** Copyright (c) Paul-Louis Ageneau and libdatachannel contributors

**License:** Mozilla Public License 2.0

**License Text:** https://www.mozilla.org/en-US/MPL/2.0/

**Source Code:** https://github.com/paullouisageneau/libdatachannel

libdatachannel is built together with the following bundled components,
which end up in the same binaries (media transport and data channels are
enabled; WebSocket support and the examples are not built, so none of their
dependencies is included):
libjuice (Mozilla Public License 2.0, Copyright (c) Paul-Louis Ageneau,
https://github.com/paullouisageneau/libjuice),
usrsctp (BSD 3-Clause, Copyright (c) 2015, Randall Stewart and Michael Tuexen,
https://github.com/sctplab/usrsctp),
libSRTP (BSD 3-Clause, Copyright (c) 2001-2017 Cisco Systems, Inc.,
https://github.com/cisco/libsrtp)
and plog (MIT, Copyright (c) 2022 Sergey Podobry,
https://github.com/SergiusTheBest/plog).

---

## Opus

The PGM Helper links the Opus audio codec (libopus, statically linked,
unmodified, release v1.5.2) to encode the audio track of the live program
preview. It is part of the macOS helper; the Windows helper prepared behind
`BROADIFY_PGM_WINDOWS=1` links the same release.

**Copyright:** Copyright 2001-2023 Xiph.Org, Skype Limited, Octasic,
Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding,
Erik de Castro Lopo, Mozilla, Amazon

**License:** BSD 3-Clause License

**License Text:** https://opus-codec.org/license/

**Website:** https://opus-codec.org/

**Source Code:** https://github.com/xiph/opus

Opus is subject to the royalty-free patent licenses listed with its license
text (Xiph.Org Foundation, Microsoft Corporation, Broadcom Corporation).

---

## Other Dependencies

All npm dependencies are listed in `package.json` and `apps/bridge/package.json`. Most dependencies use permissive licenses (MIT, Apache-2.0, BSD-2-Clause, ISC).

For a complete list of dependencies and their licenses, run:

```bash
npm list --depth=0
```

---

## License Compliance

This application complies with all applicable open-source licenses. For detailed license information, see the `LICENSE` file.

If you have questions about licensing, please contact: broadify GmbH, Bahnhofweg 7, 78333 Stockach
