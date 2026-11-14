# Air Whiteboard

A lightweight browser whiteboard for writing, sketching, and explaining with a
laptop webcam and bare hands, or with a mouse or trackpad.

- **Pinch** thumb and index finger to draw; open the hand to stop.
- **Pinch with both hands** to move and zoom the board.
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
| Draw | Pinch, move, open | Drag with the pen tool | – |
| Dot | Short pinch tap | Click | – |
| Move board | Pinch both hands, move together | Hold Space and drag, middle button, or Move tool | – |
| Zoom | Pinch both hands, move apart/together | Wheel or trackpad pinch (anchored at the pointer) | – |
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
3. Hold one hand up, open; watch the hover ring follow the thumb/index midpoint.
4. Pinch and write “1 + 1”; open the hand between strokes.
5. Pinch the **Red** swatch, release, write “= 2”.
6. Pinch with both hands and spread them to zoom; release both.
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
