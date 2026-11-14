# Architecture

```text
Camera (getUserMedia) ── newest frame ──> FrameScheduler ── ImageBitmap (transferred) ──> inference worker
   src/camera/                              one op in flight,                              src/tracking/worker/
                                            one-slot newest frame                          MediaPipe HandLandmarker
                                                    │
                                     validated result (epoch, seq, landmarks)
Replay record (dev) ─────────────────────────────────┤
                                                     ▼
                         HandPipeline: features → identity → mapping → discontinuity → One Euro
                         src/tracking/hand-pipeline.ts          (pure, DOM-free)
                                                     │ HandSample[]
                                                     ▼
                         Gesture reducer (pure state machine)    src/input/hand-reducer.ts
                                                     │ Intent[]
Pointer / keyboard / toolbar ── commands ────────────┤
                                                     ▼
                         BoardController: document, history, view, active stroke, eraser
                         src/board/                                  (pure, DOM-free)
                                                     │ change events
                                                     ▼
                         BoardRenderer: front/back caches, incremental ink, overlays
                         src/render/                                  (Canvas 2D)
```

## Module map

| Directory | Responsibility |
|---|---|
| `src/app/` | Composition root (`app.ts`), validated config with units and bounds (`config.ts`), camera/worker lifecycle owner (`camera-session.ts`), hand-input orchestration (`hand-input.ts`), page interruptions, practice session and tracker, metrics, asset descriptors. |
| `src/camera/` | Permissions and error classes, stream ownership, frame admission. |
| `src/tracking/` | Worker protocol with runtime validation, worker adapter (GPU/CPU selection), the worker itself, landmark features, two-hand identity, the observation pipeline. |
| `src/input/` | Camera→surface mapping, gesture reducer, intent application, pointer and keyboard adapters. |
| `src/signal/` | One Euro filter, discontinuity detector, transient prediction (off by default). |
| `src/board/` | Chunked point storage, strokes and the stroke builder, document, history, view math, eraser hit testing, board controller. |
| `src/render/` | Stroke geometry, renderer with caches, uncached full render, PNG export. |
| `src/ui/` | DOM controls: toolbar, camera panel, dialogs, settings, practice, preview, layout of hand targets, announcer. |
| `src/dev/` | Development/bench only (stripped from production): HUD, replay format/runner/player, landmark recorder, test handle. |

## Key rules (plan §5, §16)

- Observation, intent, document state, and visual prediction are separate.
  The reducer consumes every accepted result in order and never touches the
  document; the controller is the only writer; the renderer only reads.
- Pure modules (`signal`, `board`, `input/hand-reducer`, `input/mapping`,
  `tracking/features|identity|hand-pipeline`) use no DOM, clocks, or timers;
  time comes from source timestamps. This is what makes replay deterministic.
- Clock domains: worker durations are worker-local; main-thread timings use
  main-thread `performance.now()`; media timestamps are only used for sample
  intervals. Cross-context values are never subtracted.
- Every received ImageBitmap has exactly one owner that closes it.
- Production builds drop `src/dev/` entirely (`__DEVTOOLS__` is a
  compile-time `false`); a browser test scans the bundle for dev markers.

## Decision records

- [0001 Worker packaging](decisions/0001-worker-packaging.md)
- [0002 Tracking backend](decisions/0002-tracking-backend.md)
- [0003 Smoothing presets](decisions/0003-smoothing-presets.md)
- [0004 Coordinate mapping and identity](decisions/0004-coordinate-mapping.md)
- [0005 Renderer](decisions/0005-renderer.md)
- [0006 Fallbacks](decisions/0006-fallbacks.md)
