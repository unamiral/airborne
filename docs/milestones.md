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

## M3 — Editing and recovery (branch `m3-editing-recovery`)

### Completed
- Semantic control strip (three columns of 48 px native buttons with labels,
  pressed/disabled states): pen, eraser, move, pause/resume, six labelled
  colors (≥ 4.5:1 contrast), three widths, undo, redo, clear, fit, 100%, and
  placeholders for export/settings/help (M4). Every button is a hand target
  with hover/press feedback that does not rely on color.
- Clear confirmation dialog (`<dialog>`, Cancel focused by default, Escape
  cancels); a modal dialog owns hand input (the board absorbs pinches).
- Pause/resume by button, P, Escape, and hand; while paused, controls stay
  operable by hand but the board is never edited (found while testing: a hand
  that paused could not resume).
- Lifecycle: blur and hidden tab pause editing and inference; > 30 s hidden
  stops the camera with an explanation; pagehide stops everything; camera
  unplug/track end and worker crash keep the board; 2D context restoration
  rebuilds caches from the vector document.
- Validated config updates applied at idle boundaries; CONFIG_VERSION 2 with
  v1 → v2 migration for recorded fixtures.

### Checks run
- Vitest: 225 tests (adds paused-control, interruption timer, toolbar
  routing/contrast, config migration, fist-safety replays).
- Playwright: 36 tests (adds 5 production editing tests and 6 bench
  hand-UI/lifecycle tests with the fake camera).

### Failures and unmeasured
- Not done: the five-minute zero-accidental-erase trials with three testers,
  real camera unplug, real GPU context loss (only the restore path is wired).

### Next step
M4: settings (stabilizer, reach, camera, preview, fist gesture), guided
practice, PNG export, accessibility pass.

## M4 — Complete usable interface (branch `m4-interface`)

### Completed
- PNG export of the current viewport (dedicated surface at the visible raster
  size, white background, committed ink plus a confirmed active stroke, no
  overlays; encoder failures reported; object URLs revoked).
- Settings dialog: steadiness presets with plain-language help, reach slider
  with hand-sized ± buttons, fist-gesture and preview switches, camera
  selection after permission, reset to defaults; changes apply at the next
  idle boundary through the validated config path.
- Guided practice on a separate board (draw ≥ 40 px, pan ≥ 40 px, zoom ≥ 15%,
  erase the loop), with checkmarks and text "done", skip/finish, offered once
  when the camera first becomes ready, replayable from Help; completion time
  recorded.
- Hand routing for dialogs and overlays: a modal dialog scopes hand input to
  its controls; cards over the board absorb pinches.
- Accessibility basics: accessible names on every control, pressed/checked
  states, visible focus, keyboard traversal to the board, a single status
  landmark plus a rate-limited polite live region, reduced-motion CSS.

### Checks run
- Vitest: 232 tests (adds practice tracker and export unit tests).
- Playwright: 44 tests (adds export, settings, accessibility, narrow window,
  practice, idle-boundary settings, preview toggle with inference running).

### Failures and unmeasured
- Not done: new-user practice trial (target: 4 of 5 complete within 30 s),
  screen-reader walkthrough with real assistive technology, contrast audit
  beyond the palette and button text.

### Next step
M5: debug recording, privacy/storage/offline checks, resource cycles and soak,
deployment headers, demo replay, README and requirement-to-test map.
