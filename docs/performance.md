# Performance report

All numbers below were measured on **one development laptop**, not on the
designated demo laptops the plan calls for (none were available). Treat them as
indicative. Missing evidence is marked **not measured**, never as a pass.

## Environment

| | |
|---|---|
| Machine | Apple M2 (8 cores), 8 GiB RAM, macOS 27.2 |
| Browser | Chromium 159.0.8154.6, driven by Playwright 1.65.1 |
| Mode for hardware numbers | New headless (`channel: 'chromium'`); WebGL via ANGLE Metal on the M2 GPU |
| Mode for functional tests | Playwright headless shell (software rendering; not used for performance claims) |
| Camera | Chromium fake device playing `tests/.cache/fake-camera.mjpeg`: 640×480 at 30 fps, MediaPipe test photos (4 s one hand moving, 4 s two hands); hands hover, they never pinch |
| Viewport / DPR | 1280×800, DPR 1 (DPR 2 checked functionally only) |
| Display | Headless: frames are paced by Chromium's virtual 60 Hz clock, not a physical display |
| Power / thermal | Not controlled; no temperature readings available |
| Model | `hand_landmarker.task` float16 v1, SHA-256 `fbc2a300…7cde1`; `@mediapipe/tasks-vision` 1.2.3 |

Raw data: `bench-results/*.json` (per-sample arrays are included for the
backend and pipeline benchmarks). Percentiles use linear interpolation (type 7)
over pooled raw samples; stage percentiles are never added together.

## Gate summary (plan §12)

| Metric | Target | Measured (dev laptop) | Status |
|---|---|---|---|
| Shell payload (first-party JS/CSS, gzip) | ≤ 150 KiB | 37.7 KiB (35.5 JS + 2.2 CSS) | pass |
| Cold camera-mode payload (compressed) | ≤ 20 MiB | 9.66 MiB gzip / 8.01 MiB brotli (22.6 MiB raw) | pass if the host compresses |
| Interactive shell, warm navigation | ≤ 1 s | DOMContentLoaded 7–14 ms (local server, 5 reloads) | pass |
| Ready after permission, cached | ≤ 3 s | 0.52 s (0.84 s first visit in a fresh context) | pass |
| Ready after permission, cold 25 Mbps | ≤ 10 s | 7.1 s (CDP throttling 25/5 Mbps, 20 ms RTT; uncompressed server) | pass |
| Tracking throughput (30 fps source) | ≥ 30 results/s | 30.0, 30.0, 29.9 /s (GPU); 27.5/s (CPU) | pass on GPU |
| Inference p95, preferred backend | ≤ 15 ms | 34.0 ms (GPU, pipeline run); 36.0 ms (M0 run) | **fail** |
| Frame observation → draw submission p95 | ≤ 40 ms | p50 33.6, p95 50.3, p99 51.1 ms | **fail** (dominated by inference) |
| Input math + reducer p95 | ≤ 1 ms | 0.1 ms (p99 0.2, max 6.7; n = 5,398) | pass |
| App work per active frame p95 | ≤ 8 ms | render 0.1 ms + input 0.1 ms (hover workload) | pass |
| Steady rendering p95 (normal workload) | ≤ 4 ms | 0.1 ms while drawing on a 101k-point board | pass |
| Cache rebuild chunk | ≤ 4 ms | max 3.5 ms | pass |
| Display frames within 20 ms | ≥ 95% | 99.98% of 10,796 frames (headless virtual clock) | pass (headless only) |
| App long tasks during steady use | none > 50 ms | 1 long task of 67 ms in 180 s of tracking, not attributed | **fail** (unexplained) |
| Frame queue | ≤ 1 op, no image backlog | enforced by design and tests | pass |
| App raster caches | ≤ 64 MiB | 3 viewport layers with a budget-fitted raster scale | pass (calculated) |
| Leak behavior | stable after cycles / 15 min | 20 cycles: +0.24 MiB JS heap; 15-min soak: heap 5.9–7.3 MiB, no trend | pass (page heap only) |
| Physical motion → visible ink | p50 ≤ 80 ms, p95 ≤ 120 ms | — | **not measured** (needs high-speed video) |
| Physical pinch → visible start | p95 ≤ 150 ms | — | **not measured** |

The long-task count was first reported as 3 because the benchmark leaked
`PerformanceObserver`s between runs; the raw data shows three identical 67 ms
entries in the last run (and one matching 83 ms display frame). The script
now disconnects its observer; the corrected count is one.

## Tracking backend (M0, `bench-results/m0-backend.json`)

See [ADR 0002](decisions/0002-tracking-backend.md). Warmed, 3 × 60 s per
backend: GPU inference p50/p95/p99 25.2/36.0/37.4 ms, 30.0 results/s; CPU
34.7/37.5/39.7 ms, 27.5 results/s. Input downscaling to 320×240 did not help
(`m0-input-scale.json`); the lite landmark model is rejected by the Tasks API
(missing metadata). First-ever GPU initialization on this machine compiled
shaders for 5.2–5.6 s; later starts (even in new profiles) took ~0.25 s.

## Software pipeline (M5, `bench-results/m5-pipeline.json`)

GPU, 3 × 60 s after a 5 s warm-up, two hands hovering in the fake video:

| Series | n | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|
| Worker inference (ms) | 5,398 | 23.7 | 34.0 | 37.4 | 98.3 |
| Result age at main thread (ms) | 5,398 | 25.3 | 38.0 | 46.6 | 121.9 |
| Input math + reducer (ms) | 5,398 | 0.0 | 0.1 | 0.2 | 6.7 |
| Observation → draw submission (ms) | 5,394 | 33.6 | 50.3 | 51.1 | 193.3 |
| Render / frame work (ms) | 5,394 | 0.0 | 0.1 | 0.1 | 2.0 |
| Display frame interval (ms) | 10,796 | 16.7 | 16.7 | 16.8 | 83.3 |

"Draw submission" is the main-thread time from the admitted frame's callback
to the canvas frame that used its result. It includes waiting for the worker
when the frame arrived during a busy period (newest-frame admission) and up to
one display frame of rAF wait. It is a software timestamp, not
camera-to-pixel latency.

## Startup (M5, `bench-results/m5-startup.json`)

| Case | Permission → ready | Model fetch | Detector create | First warm-up frame |
|---|---:|---:|---:|---:|
| First visit, fresh context, local server | 839 ms | 328 ms | 246 ms | 258 ms |
| Reload (HTTP cache warm) | 516 ms | 30 ms | 215 ms | 214 ms |
| Cold, 25 Mbps throttled, uncompressed | 7,111 ms | 1,896 ms | 4,915 ms (includes WASM download) | 212 ms |

Model loading starts in parallel with the permission prompt, so part of the
fetch overlaps the (instant, fake) permission decision.

## Rendering (M2, `bench-results/m2-render.json`)

503 strokes / 101,200 points: drawing a new stroke p95 0.1 ms per frame; a
continuous Space-drag pan p95 1.5–3.5 ms per frame with rebuild chunks ≤ 3.5 ms
and a progressive rebuild nearly every frame; wheel zoom p95 0.4–3.5 ms.

## Soak (M5, `bench-results/m5-soak.json`)

15 minutes, GPU, fake camera, one pointer stroke every ~20 s (every other one
undone). Per-minute inference p50 23.5–28.1 ms, p95 32.3–36.3 ms, p99
34.7–42.5 ms with no upward trend (minute 1 p95 35.0 ms, minute 15 35.2 ms);
result age p95 34.6–49.0 ms; frame work p95 0.1 ms; page JS heap 5.9–7.3 MiB
with no growth trend; the session stayed ready on GPU throughout. Accepted
results were ~1,620 per measurement window (the window is roughly 55–60 s
because of the scripted strokes). Device temperature and worker/GPU process
memory were not observable.

## Resource cycles (`tests/e2e/bench/release.spec.ts`)

20 camera start/stop cycles in the browser (CPU backend): every cycle ended
with no dedicated workers and no live camera tracks; page JS heap after
forced GC was 2.65 MB after cycle 2 and 2.91 MB after cycle 20.

## Payload (`bench-results/size-report-dist.json`)

| File | Raw | gzip | brotli |
|---|---:|---:|---:|
| WASM binary (module build) | 14,322 KiB | 4,071 KiB | 2,824 KiB |
| Hand landmarker model | 7,636 KiB | 5,660 KiB | 5,245 KiB |
| WASM loader JS | 329 KiB | 79 KiB | 66 KiB |
| Inference worker (bundles MediaPipe JS) | 154 KiB | 45 KiB | 38 KiB |
| App JS | 109 KiB | 35.5 KiB | 31.3 KiB |
| App CSS | 7 KiB | 2.2 KiB | 1.9 KiB |

## Not measured

Designated baseline and slower demo laptops, real cameras, physical
motion-to-ink and pinch-to-ink latency, DPR 2 performance, screen sharing,
worker and GPU process memory, device temperature, Edge, Windows.
