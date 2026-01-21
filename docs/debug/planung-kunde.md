So machen wir es (vermutlich aktuell)

Aktueller Weg:Electron / Chromium Renderer
↓
RGBA FLOAT Frames (16 Bytes pro Pixel)
↓
(werden als „ARGB“ betrachtet)
↓
DeckLink Output (SDI, 10bit_yuv)
↓
ATEMDas Problem dabei:
• Der Renderer liefert 16 Bytes pro Pixel (RGBA32F)
• DeckLink erwartet für SDI YUV 4:2:2 (v210 oder 2vuy)
• Es gibt keine passende Umwandlung
• Die Bytes werden falsch interpretiert

Ergebnis:
• Signal ist da
• Bild ist schwarz / grün-grau / kaputt
• Logs sehen „ok“ aus, Bild ist es nicht

Kurz:
<<Wir schicken Aktuell Grafik-Daten in einen Video-Ausgang.>>

So müssen wir es machen (korrekt & stabil)

Ziel:

SDI will Video.

Variante A – ohne Alpha (1 SDI)Electron Renderer
↓
8-bit BGRA / ARGB (4 Bytes pro Pixel)
↓
RGB → YUV 4:2:2 Konvertierung
↓
DeckLink Output (2vuy oder v210)
↓
SDI → ATEMWichtige Punkte:

    •	Renderer liefert 8-bit, nicht float
    •	Ihr konvertiert selbst nach YUV
    •	DeckLink bekommt fertiges Video

Variante B – mit Alpha (Key & Fill, 2 SDI)Electron Renderer (RGBA)
↓
SPLIT
┌─────────────┐
│ │
RGB → YUV 4:2:2 │ Alpha → Graustufen-Video
│ (Fill) │ (Key)
└─────────────┘
↓ ↓
SDI OUT A SDI OUT B
↓ ↓
ATEM External KeyDer eine Satz, den man sich merken muss

ARGB/RGBA ist intern ok –
aber SDI beginnt erst bei YUV 4:2:2.
Was wir konkret ändern müssen:

1️⃣ Renderer-Ausgabe fixen
• ❌ RGBA float (16 Bpp)
• ✅ BGRA / ARGB 8-bit (4 Bpp)

Zielwert im Log:

bufferLength = 1920 × 1080 × 4 = 8.294.400

2️⃣ Konvertierung einbauen
• RGB → YUV (Rec.709)
• Chroma Subsampling 4:2:2
• Für Debug: 2vuy (8bit_yuv)
• Für Produktion: v210 (10bit_yuv)

3️⃣ DeckLink Output nur mit YUV füttern
• ❌ kein ARGB mehr am SDI-Ausgang
• ✅ pixelFormat = 8bit_yuv oder 10bit_yuv

❌ Was wir NICHT mehr tun dürfen
• Kein „ARGB bis SDI“
• Kein Float-Framebuffer direkt ausgeben
• Kein implizites Vertrauen auf Hardware-Konvertierung

✅ Warum das dann funktioniert
• ATEM bekommt echtes Video
• Farben stimmen
• Timing stimmt
• Key & Fill funktionieren sauber

Der fehlende Schritt ist:

Renderer → Video-Konvertierung
