# 0005 — Renderer strategy

Status: accepted (M2, 2026-11-14)

## Decision

- **Surfaces.** One opaque visible Canvas 2D context requested with
  `{ alpha: false, desynchronized: true }`; the actual attributes are read back
  and shown in the dev HUD. Controls are semantic DOM outside the canvas.
- **Caches.** Two viewport-sized offscreen layers (front, back). Raster scale
  is `min(devicePixelRatio, 2, budgetScale)`, where `budgetScale` keeps
  visible + front + back within 64 MiB of calculated backing store. Cache size
  depends only on the viewport, never on the infinite world.
- **Incremental ink.** The stroke builder reports which path segments are final
  (segment i is final once point i+1 is retained). Final segments are appended
  to the front cache as they appear; only the provisional tail, held-back
  preview, and optional prediction are drawn per frame. Frame cost is
  therefore independent of stroke length (measured flat from 300 to 3,000
  points). On commit only the remaining segments are drawn into the cache;
  geometry comes from the same function, so committed ink does not change shape.
- **Invalidation.** The renderer diffs stroke ids between the front cache and
  the document. Commit and newer-on-top inserts append; other changes (erase,
  undo, redo, clear) repaint the union of affected bounds when the
  intersecting strokes total ≤ 40,000 points, otherwise run a full rebuild.
- **Rebuilds.** Full rebuilds render into the back layer in chunks that stop at
  85% of the 4 ms budget (the check runs after each stroke). A job is
  discarded and restarted if the document changes; it is swapped in only when
  complete for the same document version. Until then the previous front cache
  stays visible, so there is never a blank frame.
- **Pan/zoom.** The front cache is drawn transformed from its view to the
  current one for immediate feedback (whole-pixel blit for pure pans), while a
  rebuild renders crisp vectors for the current view.
- **Idle.** Frames are scheduled only when something is dirty, rebuilding, or
  animating an indicator.

## Deviation

The plan says rebuilds "cancel when the document/view version changes". Jobs
here cancel on document changes but are allowed to finish when only the view
changed: during a continuous gesture the view changes every frame, so a job
cancelled on every view change would never complete and newly exposed areas
would stay empty until the gesture ended, contradicting "newly exposed areas
must progressively render while the gesture continues". A finished job for a
slightly old view is shown transformed, then the next job targets the current
view (measured: 119 progressive rebuilds during a 120-step pan).

## Evidence (bench-results/m2-render.json; Chromium 159 new-headless, ANGLE Metal, Apple M2, DPR 1)

| Workload: 503 strokes, 101,200 points | render/frame p95 | rebuild chunk max |
|---|---:|---:|
| Drawing a new stroke on top | 0.1 ms | – |
| Continuous Space-drag pan | 1.5–3.5 ms | 3.5 ms |
| Wheel zoom in/out | 0.4–3.5 ms | 3.5 ms |

In Playwright's headless shell (software canvas) panning frames reach
p95 ≈ 26 ms because each frame does several full-canvas passes on the CPU; that
mode is used for functional tests only, not for performance claims.

Correctness: `tests/e2e/bench/render.spec.ts` compares the cached composition
with an uncached reference render after every operation type (mismatch
threshold: >96/255 channel difference on ≤1% of ink pixels).
