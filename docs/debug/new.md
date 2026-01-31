### Debug Plan (Key & Fill, kein Split)

Hinweis: Desktop Video Setup (Key/Fill‑Pairing) ist **korrekt** und wird ausgeschlossen.

#### Plan
1) Pixel‑Stichproben‑Logs implementieren (Renderer → Composite → Output/Helper).
2) Testpattern senden und RGBA‑Samples prüfen (Ecke + Mitte + Ecke).
3) Wenn Helper‑Output‑Samples fehlen: Logging erweitern, sodass Input/Output direkt vergleichbar sind.
4) Abgleich mit DeckLink SDK Manual:
   - Pixel‑Format Byte‑Order (ARGB/BGRA, Little‑Endian)
   - Keyer verwendet Alpha‑Kanal (kein Luma‑Key)
5) Hypothesen nach Evidenz neu ordnen und Fix ableiten.

#### Pixel‑Stichprobe (Sollwerte Testbild)
- Ecke (Rotfläche): RGBA ≈ 255,0,0,255
- Mitte (schwarzer Kreis): RGBA ≈ 0,0,0,255

#### Hypothesen (geordnet nach Wahrscheinlichkeit)
1) **Pixel‑Order/Format‑Mismatch im Helper**
   - Symptom: Fill grau/schwarz, Key sichtbar.
   - Test: `KEY_FILL_PIXEL_FORMAT_PRIORITY` auf BGRA zuerst drehen.
2) **RGBA‑Daten bereits vor Output falsch**
   - Symptom: Pixel‑Samples zeigen 0/konstante Werte.
   - Test: Renderer + Composite‑Samples prüfen.
3) **Straight vs Premultiplied Mismatch**
   - Symptom: Fill sichtbar aber dunkel/grau.
   - Test: Un‑Premultiply für `key_fill_sdi` testen.
4) **Background/Alpha‑Handling**
   - Symptom: Key korrekt, Fill schwarz trotz opakem Testbild.
   - Test: Samples prüfen, Alpha = 255?

#### SDK‑Abgleich (zu verifizieren)
- ARGB/BGRA Byte‑Order im Speicher (Little‑Endian) prüfen.
- Keyer verwendet Alpha‑Kanal (nicht Luma).
