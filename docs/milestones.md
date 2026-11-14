# Milestone reports

Each milestone lists completed behavior, checks actually run, measurements
with their context, failures and unmeasured claims, and the next step
(plan §15). "Not measured" never means "passed".

## M0 — Feasibility and contracts (branch `m0-feasibility`)

### Completed
- Vite 8 / TypeScript 6 (strict) shell; pointer-only board stub.
- Camera lifecycle owner (`src/app/camera-session.ts`): truthful stages,
  cancellable parallel start (model loads during the permission prompt),
  bounded recovery (2 restarts/min), device switch, track-ended handling.
- Real inference in an ES module worker with the pinned MediaPipe 1.2.3 and
  locally hosted, SHA-256-verified WASM and model (ADR 0001).
- Protocol with runtime validation, epochs/sequence echo, strict bitmap
  ownership, single in-flight operation, newest-skipped-frame admission.
- GPU/CPU delegate comparison and automatic fallback, including detection of
  a software-rasterized GPU (ADR 0002).
- Mirrored preview with skeleton (one-hand overlay on the board), dev HUD
  (≤4 Hz), metrics with type-7 percentiles, replay record schema + loader.

### Checks run
- `npm run typecheck`, `npm run lint`: clean.
- Vitest: 68 unit/integration tests (config, assets manifest, protocol,
  metrics, camera errors, init-error classification, replay format, frame
  scheduler, tracker client, camera session incl. 20 start/stop cycles).
- Playwright against the production build under `/air-whiteboard/` with
  CSP/Permissions-Policy: 10 tests (pointer-only startup without permission
  prompt or model download, missing media APIs, each camera failure class,
  pending-permission cancel and double click, retry after denial, real model
  on the fake camera, Stop releases the camera, same-origin requests).
- Hardware benchmark (`tests/benchmarks/backend.bench.ts`) and two
  experiments (input downscale, lite model).

### Measurements (Apple M2, Chromium 159 new-headless; details in ADR 0002)
- GPU inference p50/p95 25.2/36.0 ms, 30.0 results/s; CPU 34.7/37.5 ms, 27.5/s.
- Payload (`scripts/size-report.mjs`): first-party shell 12.5 KiB gzip
  (target ≤150 KiB, pass); cold camera mode 9.64 MiB gzip / 7.99 MiB brotli
  (target ≤20 MiB, pass). `vite preview` serves uncompressed; production
  hosting must enable gzip/brotli to realize these numbers.

### Failures and unmeasured
- Inference p95 ≤ 15 ms: **fails** (36.0 ms GPU) on this machine.
- First-ever GPU initialization on a machine: 5.2–5.6 s shader compile.
- Not measured: designated baseline/slower demo laptops, real cameras,
  physical latency, cold 25 Mbps network profile, thermal soak, memory of the
  worker/GPU process (page JS heap only).

### Bugs found by M0 tests and fixed
- Leaked worker when a start was cancelled after the model finished loading.
- Double-clicking Start cancelled it (Cancel replaced Start in place).
- `auto` kept a SwiftShader GPU delegate whose results were always stale.
- Graph errors containing ".../wasm/..." source paths were misreported as a
  runtime load failure.

### Next step
M1: mapping, identity, features, One Euro filter, pinch reducer with
provisional onset and release hold, incremental ink, replay-based signal gates.

## M1 — Writing quality (branch `m1-writing-quality`)

### Completed
- Isotropic camera→surface mapping with a single mirror and reach setting
  (ADR 0004 documents the deviation from per-axis stretching).
- Hand features from world landmarks: pinch ratio, plausible pinch pose, fist
  from joint bend + tip-to-palm distance; two-hand identity with ambiguity.
- One Euro pen filter (matches the authors' reference to 1e-9), tuned presets
  (ADR 0003), discontinuity detector (rejects isolated/multi-landmark jumps,
  never fast sweeps or corners in tests).
- Gesture reducer: provisional onset at the first pinched sample, 2-sample /
  20 ms confirmation, dots from validated taps, release hold that drops
  opening-finger samples, short-dropout reconnection (≤ 80 ms, ≤ 8 px, same
  identity, still pinched), await-release after loss/out-of-reach/strip.
- World-space strokes with spacing retention, live endpoint, corner flags;
  midpoint-quadratic geometry with exact corners; incremental ink rendering
  (finalized segments appended to the cache, live tail drawn per frame).
- Prediction implemented behind a flag (off).
- Deterministic replay runner, scripted synthetic hand scenarios, browser
  replay player, real-model landmark fixtures from test photos.

### Checks run
- Vitest: 213 tests (unit + integration), including 37 reducer tests with
  randomized invariants (30 seeds × 400 steps), 18 end-to-end replay
  scenarios, signal gates, prediction overshoot, controller invariants.
- Playwright: 13 tests (10 production, 3 bench: browser replay, playback-speed
  invariance, real model on still images).
- `npm run report:signal` → docs/signal-report.md.

### Measurements
- Signal gates (synthetic, Balanced, 30 Hz): see ADR 0003 and the report.
- Input math + reducer in the browser (bench build, headless shell, Apple M2):
  p50 0.10 ms, p95 0.28 ms, max 0.80 ms over 65 results (target p95 ≤ 1 ms).

### Failures and unmeasured
- Synthetic shape gate at σ = 2 px, sharp held-out vertices, 15 Hz corners:
  fail (ADR 0003).
- Not done: five-minute live writing trial, real-camera recordings, raw vs
  filtered comparison on real traces, user trials of presets.
- A thumbs-up counts as a fist (four-finger definition, as specified).

### Next step
M2: board navigation (two-hand transform, pointer pan/zoom, reset/fit),
renderer cache behavior under pan/zoom, F14–F16/F29 browser checks.

## M2 — Board and navigation (branch `m2-board-navigation`)

### Completed
- World-space document with ordered insertion, view math (anchored zoom,
  two-hand transform with clamping and continuous rebase, fit/reset).
- Two-hand arbitration in the reducer (cancel short early strokes, keep late
  writing, simultaneous start, await release, expiry-based recovery).
- Bounded raster cache with incremental append, region repaint, chunked
  rebuilds, transformed snapshots during gestures (ADR 0005).
- Pointer pan (Space-drag, middle button, move tool) and wheel/trackpad zoom
  anchored at the pointer; reset/fit in the controller (toolbar in M4).

### Checks run
- Vitest: 216 tests (adds anchor-through-replay tests).
- Playwright: 25 tests (adds 8 renderer/navigation and 4 pointer/workload tests
  in the bench build).
- GPU-canvas workload benchmark (`tests/benchmarks/render-workload.bench.ts`).

### Measurements (Apple M2, Chromium 159 new-headless, DPR 1)
- Two-hand transform anchor error < 1 px on every update in replay; < 0.01 px
  in pure math (500 random updates).
- Normal workload (503 strokes / 101k points): drawing p95 0.1 ms, panning
  and zooming frames p95 ≤ 3.5 ms, rebuild chunks ≤ 3.5 ms, zero blank frames.

### Failures and unmeasured
- Not measured: physical display smoothness, DPR > 1 performance on real
  hardware, screen-sharing conditions, the slower comparison laptop.
- A single stroke larger than what fits in one chunk is drawn in one piece
  (chunks split between strokes, not within one).

### Next step
M3: clear confirmation, pause/resume UI, lifecycle interruptions (blur,
hidden tab, pagehide, track end, worker crash) wired into hand input.
