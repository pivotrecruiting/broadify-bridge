# Vendored third-party: stb single-file headers

Both headers come from nothings/stb (master branch) and are dual-licensed
MIT / Public Domain (see the license block at the bottom of each header —
either license may be chosen).

## stb_image_write.h

- **Version:** v1.16 (`stb_image_write - v1.16`)
- **Source:** https://raw.githubusercontent.com/nothings/stb/master/stb_image_write.h
  (fetched 2026-07-07)
- **SHA-256:** `cbd5f0ad7a9cf4468affb36354a1d2338034f2c12473cf1a8e32053cb6914a05`

Windows and Linux never had a real MJPEG preview encoder: the non-Apple
`encodeJpeg` in `src/preview/mjpeg_server.cpp` returned a 141-byte placeholder,
so the builder preview stayed blank. macOS encodes via ImageIO. This header
provides the platform-neutral JPEG encoder for the non-Apple path.

`STB_IMAGE_WRITE_IMPLEMENTATION` is defined in exactly one translation unit
(`src/preview/mjpeg_server.cpp`, non-Apple branch). The preview encodes at
quality 70 to match the macOS ImageIO path (a deliberate preview-only
bandwidth/CPU choice).

## stb_image.h

- **Version:** v2.30 (`stb_image - v2.30`)
- **Source:** https://raw.githubusercontent.com/nothings/stb/master/stb_image.h
  (fetched 2026-07-07)
- **SHA-256:** `594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3`

Same story on the decode side: the non-Apple `decodeImageBytes` in
`src/compose/compositor.cpp` was a nullptr stub, so cornerbug logos
(image_data_url), uploaded company background images and rendered media pages
(PiP) all fell back to the placeholder on Windows/Linux. macOS decodes via
ImageIO/CoreGraphics.

`STB_IMAGE_IMPLEMENTATION` is defined in exactly one translation unit
(`src/compose/compositor.cpp`, non-Apple branch), restricted to PNG and JPEG
(`STBI_ONLY_PNG`/`STBI_ONLY_JPEG`, `STBI_NO_STDIO`). The decoder probes the
header first and rejects images over 4096x4096 (the Apple path's cap) before
allocating pixels, and premultiplies alpha to match the CoreGraphics output
contract the draw paths expect.
