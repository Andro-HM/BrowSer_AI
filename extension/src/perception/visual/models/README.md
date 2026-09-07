# models/

`blazeface.onnx` — MediaPipe BlazeFace front (128×128), the PINTO_model_zoo float32
export: NHWC `[1,128,128,3]` input and four RAW SSD heads (per-layer scores `[1,512,1]` /
`[1,384,1]`, per-layer regressors `[1,512,16]` / `[1,384,16]`). No threshold and no NMS
are baked in — the 896-anchor decode, sigmoid, threshold and NMS run in `../faceBlur.ts`
(`decodeRawHeads`). Copied into `dist/models/` by the `copy-onnx-assets` plugin in
`vite.config.ts`.

COMMITTED, and that matters for licensing: this repository REDISTRIBUTES the file rather
than having each developer fetch it. The committed bytes (433,256 B, sha256
`e20e03f5…95c9`) reproduce exactly from `scripts/fetch-blazeface.sh`, whose primary source
is PINTO0309/PINTO_model_zoo `030_BlazeFace` — a directory carrying its own Apache-2.0
LICENSE, with the weights attributed upstream to google/mediapipe (also Apache-2.0). The
license text ships beside the model as
`extension/public/models/LICENSE-blazeface-Apache-2.0.txt`. Full analysis, including the
unlicensed artifact this replaced and the script bug that let it in:
`extension/public/models/NOTICE.txt` §2.

`faceBlur.ts` supports BOTH this raw-head contract and the older end-to-end one (NCHW
input, graph-baked threshold/NMS, single `[N,16]` output), dispatching on the loaded
graph's own shapes. That is deliberate: which bytes ship is a licensing decision, and it
must not be coupled to code that would have to be rewritten — in either direction — to
change it.

Absence is a supported state: the face-blur engine degrades to zero faces and the
perception pipeline continues (the Vite plugin warns instead of failing the build).
