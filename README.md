# Air Whiteboard

A lightweight browser whiteboard for writing, sketching, and explaining with a
laptop webcam and bare hands, or with a mouse or trackpad.

- **Extend your thumb, index and middle finger in roughly the same direction** and draw with your index fingertip. Angle your thumb away to stop. The close-fingertip gesture also works.
- **Use the writing gesture with both hands** to move and zoom the board.
- **Hold a fist** until the ring fills, then sweep to erase whole strokes.
- **Pinch on a control** in the left strip to use it (one action per pinch).

Hand tracking (MediaPipe Hand Landmarker) runs locally in a web worker. Camera
images are not uploaded. One board and the theme preference are saved locally in your browser; cookies remember welcome and practice choices. Export a PNG for a portable copy.

The specification is [air-whiteboard-architecture-prompt.md](air-whiteboard-architecture-prompt.md).
Milestone reports with checks and measurements: [docs/milestones.md](docs/milestones.md).

## Status

All six milestones (M0–M5) are implemented with automated tests. Evidence so
far is automated and synthetic: unit/integration tests, browser tests on
Chromium 159 against the production build, Chromium's fake camera playing
MediaPipe test photos, and hardware benchmarks on one Apple M2 development
laptop. **No real-camera sessions, user trials, physical-latency
measurements, or live demos have been carried out**, and the inference-time
gate (p95 ≤ 15 ms) is not met on that laptop. See
[Known limitations](#known-limitations) and [docs/test-map.md](docs/test-map.md).

## Quick start

Requirements: Node.js ≥ 22.12 (developed with Node 26.13 / npm 12.2), network
access once for `npm ci` and the model download, a Chromium-based browser.

```sh
npm ci
npm run dev        # http://localhost:5173 (dev server with HUD and recorder)
npm run build      # production build in dist/ (+ dist/_headers)
npm run preview    # serve dist/ with the production security headers
```

`npm run assets` (run automatically by dev/build) copies the MediaPipe WASM
loader from the pinned npm package and downloads the pinned hand model, checking
every file against the SHA-256 values in `assets.manifest.json`.

## Tests and checks

```sh
npm run typecheck          # strict TypeScript (app, worker, tests/scripts)
npm run lint               # ESLint with type-aware rules
npm test                   # Vitest: unit + integration (Node)
npx playwright install chromium webkit
npm run test:e2e           # builds dist/ and dist-bench/, then Playwright
npm run check              # all of the above
```

Browser tests need `ffmpeg` on the PATH to build the fake-camera video
(`tests/.cache/fake-camera.mjpeg`) from the MediaPipe test photos.

Benchmarks and reports (results in `bench-results/`):

```sh
npm run build:bench
npx playwright test -c playwright.bench.config.ts backend          # GPU vs CPU inference (~7 min)
npx playwright test -c playwright.bench.config.ts render-workload  # 100k-point board rendering
SOAK_MINUTES=15 npx playwright test -c playwright.bench.config.ts soak
npm run report:signal      # docs/signal-report.md (synthetic filter evaluation)
npm run report:size        # payload sizes of dist/
```

The hardware config uses Chromium's new headless mode, which renders WebGL with
the real GPU on macOS; Playwright's default headless shell uses a software
rasterizer and must not be used for GPU numbers.

## Controls

| | Hands | Mouse / trackpad | Keyboard |
|---|---|---|---|
| Draw | Thumb, index and middle aligned, draw with index, then angle thumb away | Drag with the pen tool | – |
| Dot | Brief writing pose | Click | – |
| Move board | Writing pose on both hands, move together | Hold Space and drag, middle button, or Move tool | – |
| Zoom | Writing pose on both hands, move apart/together | Wheel or trackpad pinch (anchored at the pointer) | – |
| Erase | Hold a fist ~0.2 s, then sweep | Eraser tool and drag | – |
| Undo / redo | Pinch the Undo / Redo buttons | Buttons | Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z; with the board focused also Z / Shift+Z |
| Clear | Pinch Clear, release, pinch “Clear board” | Clear → Clear board | C (board focused) → dialog |
| Pause / resume hand input | Pinch Pause | Pause button | P (board focused); Escape ends the current interaction and pauses |

The mode chip shows Hover, Draw, Move, Eraser readying, Erase, Paused, or
Tracking lost. Settings: hand steadiness (Light / Balanced / Steady), reach
(50–90% of the camera view), fist gesture on/off, camera preview on/off, and
camera selection. Help starts a 20-second practice on a separate board.

## Privacy

- Video frames and landmarks never leave the device; the app makes only
  same-origin GET requests for its own files (verified by a browser test that
  also checks for websockets, browser storage, caches, and service workers).
- The camera is requested only after **Start camera**; it is stopped by Stop,
  page hide, or a tab hidden for more than 30 seconds.
- No accounts, analytics, or crash reporting. One board is saved locally in the browser; export a PNG for a portable copy.
- Development builds include a landmark recorder (no video) with a visible
  indicator, size/duration limits, discard, and explicit export. Production
  builds do not contain it.

## Browser support

Tested: Chromium 159 on macOS 27.2 (Apple M2). Intended primary targets are
desktop Chrome and Edge on the demo laptops; these have **not** been tested
yet. Other browsers get capability checks and the full pointer workflow;
camera support is not advertised for them. Narrow windows move the controls
into a top bar. Mobile camera drawing is out of scope.

## Deployment

Static hosting over HTTPS (cameras require a secure context). The build uses
relative URLs, so it works under any subpath. Serve with the headers in
`dist/_headers` (Netlify/Cloudflare Pages format; generated from
`scripts/security-headers.ts`): a CSP with `script-src 'self'
'wasm-unsafe-eval'`, `Permissions-Policy: camera=(self), microphone=()`,
`application/wasm` for `.wasm`, and immutable caching for `assets/`. Enable
gzip or brotli: the cold camera-mode payload is 9.6 MiB gzip / 8.0 MiB brotli
(22.6 MiB uncompressed); the app shell is about 38 KiB gzip.

## Demo steps (live)

1. Open the app in Chrome, press **Start camera**, allow the camera.
2. Wait for “Tracking on this device”; accept or skip the practice offer.
3. Hold one hand up, open; watch the hover ring follow the index fingertip.
4. Extend your thumb, index and middle finger together and write “1 + 1”. Angle your thumb away between strokes.
5. Pinch the **Red** swatch, release, write “= 2”.
6. Use the writing gesture with both hands and spread your hands to zoom.
7. Hold a fist over the “2” until the ring fills, sweep across it, open.
8. Pinch **Undo** to bring it back; pinch **Export** (or click) to save a PNG.

An automated version of this script runs in `tests/e2e/bench/release.spec.ts`.

## Known limitations

- Inference p95 is 34–36 ms on GPU (Apple M2) versus the 15 ms target, so the
  software observation→draw p95 is 50 ms versus 40 ms; a lighter landmark
  model was blocked by missing model metadata (ADR 0002). One unexplained
  67 ms main-thread long task occurred in a 3-minute measurement.
- The very first GPU initialization on a machine compiled shaders for 5–6 s.
- Stabilizer presets are tuned on synthetic traces only; shape error at 2 px
  noise, sharp short-segment vertices, and 15 Hz corners miss their gates
  (ADR 0003). Prediction is implemented but disabled.
- The camera→board mapping keeps the surface aspect ratio instead of
  stretching the central 70% of both axes (ADR 0004).
- Fist recognition is based on limited hand-pose fixtures; test it with a real camera and varied hands, angles, and lighting.
- No real-camera recordings, user trials, physical latency, thermal or
  second-laptop measurements; Edge and Windows untested.
- Strokes are erased whole; no selection, text, shapes, or multi-user.

## Documentation

- [Architecture](docs/architecture.md) and [decision records](docs/decisions/)
- [Requirement-to-test map (F01–F36)](docs/test-map.md)
- [Performance report](docs/performance.md) and [signal report](docs/signal-report.md)
- [Milestone reports](docs/milestones.md)

## Licenses and attribution

- `@mediapipe/tasks-vision` 1.2.3 and its WASM: Apache-2.0 (Google).
- Hand landmarker model (float16, v1): published by Google MediaPipe under
  Apache-2.0 per its model card; downloaded at build time, not committed.
- One Euro filter (`src/signal/one-euro.ts`) adapted from the authors'
  reference implementation, Copyright 2019 Inria, BSD-3-Clause (notice kept in
  the file); the unmodified reference is used as a test oracle in
  `tests/reference/`.
- Test photos in `tests/fixtures/images/`: MediaPipe test assets, Apache-2.0.

## Handwriting cleanup

Choose **Clean** to apply an undoable cleanup to all board ink. Light applies a
bounded binomial smoothing to sampled stroke points, preserving endpoints,
marked corners, dots and stroke boundaries. Smooth and align additionally
nudges the baselines of simple, separated clusters when their sizes and
bottoms are consistent. It deliberately skips baseline correction for
ambiguous layouts. Review the result and use Undo to restore the original.
Cleanup is opt-in because diagrams, math, cursive and multi-stroke characters
cannot be reliably classified from geometry alone. It does not recognize or
reconstruct letter shapes, normalize spacing or slant, or automatically infer
words. The existing One Euro filter, jump detection, and incremental renderer
continue to handle live input. No recognition model or external service is
required for cleanup. There is no evidence yet that it improves actual
handwriting legibility; real-user and real-camera evaluation is needed.


### Tracking and restyle limitations

The extended-finger pose checks the direction and straightness of the thumb, index
and middle finger. Ring and pinky positions are unrestricted. The close-fingertip
gesture uses thumb-to-middle fingertip distance divided by wrist-to-middle-knuckle
distance. MediaPipe world landmarks are preferred, with aspect-corrected image
coordinates as a fallback. Angled or partly hidden hands can still affect the
estimate. Settings lets you tune both distances. The defaults are 0.32 palm
lengths to start and 0.55 to release. Start requires 50 ms inside the threshold.
Tracking loss ends the stroke, and returning with the gesture held cannot restart it.

A candidate for future testing is the larger sparse hand landmark model in
[WebGPU Vision](https://github.com/Sonified/webgpu-vision). Its authors report
better thumb tracking, but this application needs compatible 3D world landmarks,
a reliable multi-hand pipeline and measurements on its target hardware before
it can safely replace MediaPipe. The current model has not been replaced.

Cleanup remains geometric: it smooths ink, not the underlying letter shapes.
It does not implement Goodnotes Restyle or infer what the writing says.
