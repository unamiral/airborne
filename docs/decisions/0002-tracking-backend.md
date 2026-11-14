# 0002 — Tracking backend and delegate selection

Status: accepted for this release (M0, 2026-11-14); the inference-time gate is
**not met** on the only machine measured (see below).

## Measurements (development machine, not a designated demo laptop)

Environment: Apple M2 (8 cores, 8 GiB), macOS 27.2, Chromium 159.0.8154.6 in
new-headless mode driven by Playwright, ANGLE Metal renderer, Chromium fake
camera playing `tests/.cache/fake-camera.mjpeg` (640×480, 30 fps, MediaPipe
test photos: 4 s one hand, 4 s two hands). Power source and thermal state not
controlled. Raw samples: `bench-results/m0-backend.json`.
Protocol: fresh context, cold start reported separately, 5 s warm-up
excluded, then 3 × 60 s runs; percentiles from pooled raw samples.

| Metric (per accepted result) | GPU (Metal) | CPU (WASM SIMD) |
|---|---:|---:|
| Worker-local inference p50 / p95 / p99 / max (ms) | 25.2 / 36.0 / 37.4 / 49.3 | 34.7 / 37.5 / 39.7 / 57.5 |
| Accepted results per second (source 30 fps) | 30.0, 30.0, 30.0 | 27.4, 27.5, 27.6 |
| Result age at main thread p50 / p95 (ms) | 26.9 / 42.3 | 43.9 / 61.6 |
| ImageBitmap snapshot p95 (ms) | 0.2 | 0.2 |
| postMessage round trip minus inference (p50, ms) | ≈0.2 | ≈0.2 |
| Model fetch + SHA-256 verify (local server, ms) | 315 + 29 | 262 + 21 |
| Detector creation (ms) | 253 | 212 |
| First warm-up inference (ms) | 253 (5197–5607 on the first-ever run) | 68 |
| Start press → tracker ready, fake permission (ms) | 909 | 673 |

GPU first-run note: the very first GPU initialization on this machine took
5.2–5.6 s in the first warm-up inference (shader compilation). After that,
even fresh browser profiles started in ~0.25 s (`gpuPersistentProfileStarts`),
consistent with an OS-level shader cache. A user's first-ever visit on a new
machine may therefore wait several seconds once.

Software GL: in Playwright's headless shell the GPU delegate runs on
SwiftShader at ~115 ms per warm-up frame and ~240 ms per inference, so every
result was stale and the app never tracked. That is now detected (see
Decision).

Experiments that did not help (M0):
- Downscaling the admitted frame to 320×240: GPU p50 26.2 vs 23.5 ms, CPU 37.1
  vs 36.6 ms (`bench-results/m0-input-scale.json`). Model execution dominates;
  full resolution is kept for landmark precision.
- Swapping in MediaPipe's lite landmark model: the Tasks API rejects the legacy
  `hand_landmark_lite.tflite` ("requires NormalizationOptions metadata"). Adding
  TFLite metadata needs the metadata-writer toolchain; not pursued in M0.

## Decision

- Default `auto`: try the GPU delegate first. After initialization the worker
  reports warm-up durations; if the median after the first (compile) frame
  exceeds 50 ms, a CPU worker is also started and the faster one is kept. GPU
  creation failures fall back to a fresh CPU worker. Model download/integrity
  failures are not retried with another delegate.
- `?backend=gpu|cpu` forces a delegate (used by benchmarks).
- Rationale: on the measured machine GPU sustains the full 30 results/s with a
  lower result age; CPU reaches 27.5/s with ~17 ms more result age.
- Throughput fix found while measuring: frames arriving during inference used
  to be dropped and the pipeline idled until the next frame (21–24 results/s on
  GPU, 15/s on CPU). The scheduler now keeps the newest skipped frame's
  metadata (one slot, no image queue) and admits it as soon as the worker is
  free (plan: "when free, snapshot the newest available frame").

## Gate status (plan §12)

| Gate | Target | Measured here | Status |
|---|---|---|---|
| Inference p95, baseline preferred backend | ≤ 15 ms | 36.0 ms (GPU) | **fail** on this machine |
| Tracking throughput | ≥ 30/s when camera supplies it | 30.0/s (GPU), 27.5/s (CPU) | pass (GPU) |
| Frame queue | ≤ 1 admitted op, no image backlog | enforced + tested | pass |
| Ready after permission, cached assets | ≤ 3 s | 0.4–0.9 s (warm shader cache); 5.2–5.6 s first-ever GPU run | pass except first-ever GPU run |
| Ready, cold 25 Mbps profile | ≤ 10 s | not measured (local server only) | not measured |
| Physical latency, thermal soak, second laptop | — | not measured | not measured |

The inference gate failure is real and unresolved. TensorFlow.js hand-pose
detection (plan §3) is the documented alternative to evaluate if this gate must
be met on the demo laptops; it was not evaluated in this session.
