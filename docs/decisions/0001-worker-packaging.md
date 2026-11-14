# 0001 — Inference worker packaging

Status: accepted (M0, 2026-11-14)

## Context

The plan requires inference off the main thread in one worker, verified in the
deployed production bundle rather than assumed (plan §2, §6 "Worker capability
spike"). MediaPipe worker loading has had version-specific problems
([google-ai-edge/mediapipe#5257](https://github.com/google-ai-edge/mediapipe/issues/5257)).

What the pinned `@mediapipe/tasks-vision@1.2.3` does (read from
`vision_bundle.mjs`): inside a worker it first calls `importScripts(loader)`;
in a module worker that throws `TypeError`, after which it falls back to
dynamic `import(loader)`. The classic loader (`vision_wasm_internal.js`)
defines `ModuleFactory` only as a module-scoped variable when imported, so the
fallback fails with it. The package also ships `vision_wasm_module_internal.js`,
which ends with `globalThis.ModuleFactory = ModuleFactory; export default ...`.
This release ships only SIMD WASM variants.

## Decision

- An ES module worker (`new Worker(new URL(...), { type: 'module' })`), bundled by
  Vite (`worker.format: 'es'`), is the only worker path. No classic worker and no
  `importScripts` patches.
- The worker builds its `WasmFileset` explicitly from
  `vision_wasm_module_internal.{js,wasm}` instead of using `FilesetResolver`.
- WASM loader/binary are copied from the pinned npm package and the model is
  downloaded once from its pinned URL by `scripts/assets.mjs`; every file is
  checked against SHA-256 values in `assets.manifest.json`. All are served from
  the app origin under versioned paths (`assets/mediapipe/1.2.3/`,
  `assets/models/hand_landmarker/float16-1/`).
- The main thread resolves absolute asset URLs against `document.baseURI` and
  passes them to the worker, because the worker resolves relative URLs against
  its hashed chunk location. This makes the build work under any subpath.
- The worker fetches the model itself (timeout via `AbortController`), checks
  byte length and SHA-256 with WebCrypto, then passes `modelAssetBuffer`.
- CSP: `script-src 'self' 'wasm-unsafe-eval'`. The loader contains no `eval`
  or `new Function` (checked by grep in M0), so `unsafe-eval` is not granted.

## Evidence

- `tests/e2e/camera-real.spec.ts` (production build under `/air-whiteboard/`
  with CSP and Permissions-Policy headers): real model + module worker tracks
  hands from the fake camera, zero CSP violations, all requests same-origin.
- Works with both delegates in Chromium 159 (headless shell and new-headless).
- `tests/unit/init-errors.test.ts` covers creation-error classification.

## Consequences

- Browsers without module-worker support cannot run hand tracking; they keep
  pointer mode. No main-thread inference compatibility mode was added (plan §6
  allows one only if measured task durations are acceptable; 25–37 ms
  synchronous calls on the main thread would not be).
- Upgrading MediaPipe means updating `assets.manifest.json`, `src/app/assets.ts`
  (a unit test checks they agree), and re-running the packaging tests.
