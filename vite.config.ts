import { defineConfig } from 'vite';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import manifest from './extension/manifest.ts';

// PrivAgent build (M0 scaffold).
// Vite 8 transforms with Rolldown/oxc (not esbuild), so JSX is configured via `oxc.jsx`
// (automatic runtime, default `react` import source). @vitejs/plugin-react is intentionally
// omitted for the scaffold to avoid the Vite 8 rolldown/oxc-babel/react-compiler peer chain.

/**
 * Copies the ONNX Runtime WASM runtime and the BlazeFace model (when present —
 * `scripts/fetch-blazeface.sh` fetches it; absence degrades gracefully to zero faces)
 * into dist/ as static assets. Both ONNX consumers — the OmniParser vision provider and
 * the face-blur engine — point `env.wasm.wasmPaths` at this ONE directory.
 */

/**
 * The ORT runtime variant this build can actually load — NOT a guess.
 *
 * `onnxruntime-web@1.29.0`'s package exports resolve a browser `import 'onnxruntime-web'`
 * to `dist/ort.bundle.min.mjs`, and that file hard-codes exactly two ORT asset names:
 * `ort-wasm-simd-threaded.jsep.{wasm,mjs}`. There is no runtime variant selection in this
 * entry point, so the `asyncify` (24.6 MB), `jspi` (15.3 MB) and non-JSEP base (13.3 MB)
 * binaries are unreachable from it — they belong to the `ort.jspi.*` / `ort.all.*` entry
 * points, which nothing here imports (verified: the only `onnxruntime-web` imports are
 * `providers/vision-onnx.ts` and `faceBlur.ts`, both bare specifiers).
 *
 * Independent confirmation: Rolldown follows the same file's
 * `new URL('ort-wasm-simd-threaded.jsep.wasm', import.meta.url)` reference and emits ONLY
 * that variant into `dist/assets/` — never asyncify, jspi or base.
 *
 * ONE binary covers BOTH execution paths (CONTRIBUTING.md §10): JSEP *is* the WebGPU
 * execution provider, and the same artifact runs the wasm/CPU fallback. Pruning the other
 * three variants therefore removes ~53 MB without touching either path.
 *
 * An earlier reduction attempt DID break at runtime with a "dynamically imported module"
 * error (PROJECT_STATUS §9l defect #1) because it shipped the *base* pair and dropped
 * jsep — the exact opposite subset. Keeping the `.mjs` glue matters: this "bundle" build
 * still resolves it as a separate module next to the `.wasm`.
 */
const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
] as const;

function copyOnnxAssets() {
  return {
    name: 'copy-onnx-assets',
    closeBundle() {
      const ortSource = 'node_modules/onnxruntime-web/dist';
      const ortOut = 'dist/ort';
      mkdirSync(ortOut, { recursive: true });
      // Fail LOUDLY rather than shipping a runtime that 404s on first session create: an
      // ORT upgrade that renames the variant must break the build, not the extension.
      const available = new Set(readdirSync(ortSource));
      const missing = ORT_RUNTIME_FILES.filter((file) => !available.has(file));
      if (missing.length > 0) {
        throw new Error(
          `[privagent] onnxruntime-web no longer ships ${missing.join(', ')}. ` +
            'Re-derive the required variant from the asset names in dist/ort.bundle.min.mjs ' +
            'before changing this list.',
        );
      }
      for (const file of ORT_RUNTIME_FILES) {
        copyFileSync(`${ortSource}/${file}`, `${ortOut}/${file}`);
      }
      const model = 'extension/src/perception/visual/models/blazeface.onnx';
      if (existsSync(model)) {
        const modelOut = 'dist/models';
        mkdirSync(modelOut, { recursive: true });
        copyFileSync(model, `${modelOut}/blazeface.onnx`);
      } else {
        console.warn('[privagent] blazeface.onnx not found — face detection disabled (pipeline continues)');
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), crx({ manifest }), copyOnnxAssets()],
  // Bundled OCR runtime assets (Tesseract worker, wasm core, eng language data) live
  // under extension/public and are copied verbatim into dist/ so they load offline
  // from the extension origin via chrome.runtime.getURL('ocr/...').
  publicDir: 'extension/public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
});
