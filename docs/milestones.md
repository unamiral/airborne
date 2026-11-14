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
