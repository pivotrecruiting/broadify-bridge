# Integration – Konfig‑Schemas (Auszug)

## Graphics Output Config (Zod)
Quelle: `apps/bridge/src/services/graphics/graphics-schemas.ts`

Felder:
- `outputKey`
- `targets` (`output1Id`, `output2Id`, `ndiStreamName`)
- `format` (`width`, `height`, `fps`)
- `range` (`legal|full`)
- `colorspace` (`auto|rec601|rec709|rec2020`)

## Runtime Config (Bridge)
Quelle: `apps/bridge/src/services/runtime-config.ts`

Felder:
- `outputs` (output1/output2)
- `engine` (type, ip, port)
