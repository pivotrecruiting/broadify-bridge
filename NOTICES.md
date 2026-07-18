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

## Other Dependencies

All npm dependencies are listed in `package.json` and `apps/bridge/package.json`. Most dependencies use permissive licenses (MIT, Apache-2.0, BSD-2-Clause, ISC).

For a complete list of dependencies and their licenses, run:

```bash
npm list --depth=0
```

---

## License Compliance

This application complies with all applicable open-source licenses. For detailed license information, see the `LICENSE` file.

If you have questions about licensing, please contact: [Your Contact Information]
