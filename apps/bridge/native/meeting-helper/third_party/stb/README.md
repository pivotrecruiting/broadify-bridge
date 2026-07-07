# Vendored third-party: stb_image_write

- **File:** `stb_image_write.h`
- **Version:** v1.16 (`stb_image_write - v1.16`)
- **Source:** https://raw.githubusercontent.com/nothings/stb/master/stb_image_write.h
  (nothings/stb, master branch, fetched 2026-07-07)
- **SHA-256:** `cbd5f0ad7a9cf4468affb36354a1d2338034f2c12473cf1a8e32053cb6914a05`
- **License:** dual-licensed MIT / Public Domain (see the license block at the
  bottom of the header — either license may be chosen).

## Why

Windows and Linux never had a real MJPEG preview encoder: the non-Apple
`encodeJpeg` in `src/preview/mjpeg_server.cpp` returned a 141-byte placeholder,
so the builder preview stayed blank. macOS encodes via ImageIO. This header
provides the platform-neutral JPEG encoder for the non-Apple path.

`STB_IMAGE_WRITE_IMPLEMENTATION` is defined in exactly one translation unit
(`src/preview/mjpeg_server.cpp`, non-Apple branch). The preview encodes at
quality 70 to match the macOS ImageIO path (a deliberate preview-only
bandwidth/CPU choice).
