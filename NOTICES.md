# Third-Party Notices

This file contains attributions and notices for third-party software used in this application.

## FFmpeg

This application includes FFmpeg, a multimedia framework.

**License:** GNU Lesser General Public License (LGPL) v2.1 or later

**Source Code:** https://git.ffmpeg.org/ffmpeg.git

**Build Information:**

- Configuration: See `docs/ffmpeg-setup.md` and `docs/build-process.md`
- Build Scripts: See `scripts/build-ffmpeg-decklink.js` (if available)

**Note:** If FFmpeg was compiled with `--enable-gpl`, the GPL license applies. See `LICENSE` file for full GPL license text.

---

## Blackmagic DeckLink SDK

This application uses FFmpeg compiled with Blackmagic DeckLink SDK support for SDI output functionality.

**Provider:** Blackmagic Design

**License:** Proprietary (see Blackmagic Design EULA)

**Website:** https://www.blackmagicdesign.com/support/family/desktop-video-sdk

**Note:** The DeckLink SDK is used at build time only. The SDK itself is not distributed with this application. Users must install Blackmagic Desktop Video drivers separately.

---

## NewTek NDI (if used)

This application may use NDI (Network Device Interface) for video streaming.

**Provider:** NewTek (Vizrt)

**License:** Proprietary (commercial license required)

**Website:** https://www.ndi.tv/

**Note:** Commercial use of NDI requires a license from NewTek. The NDI SDK is used via FFmpeg's `libndi_newtek` format.

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
