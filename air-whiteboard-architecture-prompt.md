# Air Whiteboard: comprehensive architecture and implementation prompt

Prepared November 14, 2026. This is a planning deliverable, not an implemented or benchmarked application. Numeric settings below are proposed starting values or acceptance targets, explicitly identified as such.

Use the prompt below as the initial specification for a coding agent. The supplied seven-page project brief informs the product, but this specification revises its implementation choices where they conflict with usability, correctness, accessibility, or measured performance.

---

## 1. Mission, priorities, and scope

Build a lightweight browser whiteboard that lets students write, sketch, and explain using a laptop webcam and bare hands. Pinching draws, two pinching hands move and zoom the board, and a deliberately held fist erases. The app must also work with a mouse or trackpad without camera access.

Optimize in this order:

1. Preserve the user's intent: no unexplained strokes, accidental erasure, disappearing punctuation, hand swaps, or destructive recovery.
2. Make handwriting stable and responsive, including slow curves, small letters, dots, sharp corners, and fast direction changes.
3. Keep interaction understandable: visible pen position, clear modes, immediate feedback, easy recovery, minimal learning.
4. Keep the app small, locally processed, maintainable, and easy to measure.
5. Add visual polish after the preceding properties are demonstrated.

Do not promise perfectly smooth handwriting regardless of arbitrary hand motion. Camera noise, physiological shake, tracking failures, and intentional corners are different phenomena. A causal algorithm cannot always infer which motion was intended. The product goal is measurable noise reduction without unacceptable delay or shape distortion, with a useful stabilizer setting and conservative behavior when tracking becomes ambiguous.

### Required first release

- Camera permission, selection, start/stop, readiness, actionable error recovery, and local inference.
- One-hand drawing, hover, stable hand ownership, and controlled tracking-loss behavior.
- Smooth constant-width ink, preserved dots and endpoints, adjustable stabilization.
- Infinite vector board; simultaneous two-hand pan/zoom; reset and fit view.
- Whole-stroke erasing with an arming indicator and undo.
- Color and brush controls accessible by hand, pointer, and keyboard.
- Undo, redo, confirmed clear, pause, and pointer input fallback.
- Short guided practice, persistent mode feedback, optional mirrored camera preview.
- Explicit PNG export of the current board viewport, excluding controls and camera imagery.
- Developer metrics, deterministic landmark replay, automated tests, hardware benchmarks, and a repeatable demo.

PNG export and pointer fallback are small additions to the brief that make the result useful and recoverable. They share the same board model and renderer.

### Deferred scope

No accounts, backend, multiplayer, handwriting recognition, AI solving, automatic graphing, selection/lasso, shape recognition, text editing, native app, pressure simulation, automatic board saving, or service worker in this release. No need to build extension infrastructure for these features. Preserve clean module boundaries so they remain possible later. An infinite coordinate space does not imply unlimited storage.

Primary support: desktop Chrome and Edge on the actual demo laptops. Record exact browser/OS/hardware versions during validation. Other browsers get capability checks and pointer mode; do not advertise camera support until tested. Mobile camera drawing is outside this release. Basic controls should still fit a narrow window.

## 2. Decisions that revise the original brief

| Brief assumption | Required decision | Reason |
|---|---|---|
| Drop the first two or three points of a pinch stroke | Preserve onset samples in a short provisional buffer | Dropping samples can remove dots, small symbols, and the beginning of letters. |
| Smooth every relevant landmark the same way | Separate the pen-coordinate filter from fast gesture features | Heavy coordinate filtering must not delay pen-up or change pinch thresholds. |
| Predict one or two frames ahead | Use a bounded time horizon, transient preview only, conditional on motion stability | Frame durations vary; prediction can overshoot corners and stops. |
| Bridge every short dropout | Freeze immediately; reconnect only under strict continuity checks | An invisible hand may have moved, released, or changed identity. |
| Put all controls inside the drawing canvas | Use semantic DOM controls in a reserved strip beside the canvas | Keyboard access and maintainable UI matter. Keep controls outside the ink surface. |
| An ImageBitmap transfer is always zero-copy | Measure snapshot, transfer, and upload costs separately | Transferability does not guarantee a zero-copy end-to-end pipeline. [Transfer semantics](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects). |
| MediaPipe always needs a classic worker | Probe the pinned package in the production build | Worker packaging has had version-specific problems. Isolate any classic-worker workaround. [Upstream issue](https://github.com/google-ai-edge/mediapipe/issues/5257). |
| GPU is necessarily faster | Compare GPU and CPU workers on target hardware | Delegate overhead and contention must be measured for this workload. |
| A handedness score is tracking confidence | Treat it only as handedness classification confidence | The documented result separates landmarks, world landmarks, and handedness; it does not supply a general tracking-quality score. [Result API](https://developers.google.com/edge/api/mediapipe/js/tasks-vision.handlandmarkerresult). |
| Timestamping JavaScript gives frame-to-pixel latency | Label software pipeline timing accurately; measure physical latency separately | Camera exposure and actual display presentation are not fully observable from ordinary JavaScript timestamps. |
| Never allocate anything per frame | Bound app-owned allocation and resource lifetimes; profile garbage collection | Browser snapshots and third-party inference may allocate. Avoid an impossible absolute requirement. |
| Ask before any unlisted dependency | Select justified dependencies and document their costs | The current project direction explicitly allows more efficient alternatives. |

The desynchronized canvas option is an optimization hint with conditions, not a blanket guarantee that rendering bypasses all composition or that DOM UI is forbidden. Use an opaque board canvas and benchmark the actual layout. [Chrome guidance](https://developer.chrome.com/blog/desynchronized/).

## 3. Recommended stack and dependency policy

Use TypeScript in strict mode, Vite, native DOM/CSS, Canvas 2D, and one inference worker. This interface does not initially need React, a router, a scene graph, or a global-state framework. If an existing repository already has a small established UI framework, reuse it rather than rewriting its shell; keep frame data outside its reactive render cycle.

Use `@mediapipe/tasks-vision` Hand Landmarker as the initial tracking backend: VIDEO mode, maximum two hands, pinned package and matching locally hosted WASM/model files. Its web API supports synchronous video-frame detection, so isolate inference from UI work. [Official guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker?tab=Web).

Use a small local, attributed implementation of One Euro filtering, checked against the authors' implementation. Keep its public interface tiny and unit-tested. Do not add an unverified filtering dependency just to avoid maintaining a small mathematical function. Preserve the upstream license when adapting source. [Author-maintained implementations](https://gery.casiez.net/1euro/).

Render constant-width ink with native incremental paths first. `perfect-freehand` is an evaluation candidate, not an initial requirement. It exposes streamlining and speed-based pressure simulation; those can add unwanted geometry changes for small handwriting. If evaluated, use constant width, minimal additional streamlining, and compare live/committed endpoints and processing time. [Library documentation](https://github.com/steveruizok/perfect-freehand).

Only evaluate TensorFlow.js hand-pose detection if the initial backend misses compatibility or performance gates after profiling. Its documented TFJS runtime has lite/full options and additional runtime/backend dependencies. It is a credible alternative, not evidence of a speed advantage on our machines. [TFJS backend documentation](https://github.com/tensorflow/tfjs-models/blob/master/hand-pose-detection/src/tfjs/README.md).

Use Vitest for mathematical/domain tests and Playwright for browser flows. Keep tests, fixtures, profiling tools, and debug controls out of the production bundle. Add a spatial-index dependency only if the straightforward bounding-box approach fails the stated board-size benchmark. Avoid OpenCV.js, a custom ML runtime, WebGPU rendering, SharedArrayBuffer, and extra rendering workers until a measured bottleneck justifies them.

Pin exact versions and commit one lockfile. Record dependency purpose, production transfer size, license/notice requirements, and replacement boundary. Pin model identity and checksum separately from npm versions. Do not copy a version number from this prompt: resolve and verify versions during M0.

## 4. User experience contract

### First visit and camera setup

Show a usable blank board immediately, with “Start camera,” “Use mouse,” and a short explanation: hand tracking happens on this device, camera imagery is not uploaded, and the board is kept in this tab unless exported. Do not trigger the permission prompt before the user starts camera mode.

Once started, show truthful stages: requesting permission, loading tracking, finding a hand, ready. A loading indicator must not pretend to know download progress that has not been measured. Camera permission may remain unanswered; keep a visible cancel action and pointer mode available.

Request video only, initially 640×480 and 60 fps as ideal constraints, not mandatory constraints. Report actual track settings and measured frame cadence internally. Offer camera selection after permission makes device labels available. Use a muted, inline video element. Explain permission denial, no camera, camera already in use, insecure origin, model-load failure, and unsupported inference separately. Camera permission requires a secure context. [getUserMedia documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

### Workspace layout

Reserve a narrow, visually quiet control strip outside the board. Include pen/eraser, six labeled high-contrast colors, three brush widths, undo, redo, clear, reset/fit view, export, pause, and settings. Use native buttons with labels, pressed states, and visible focus. Hand-selectable targets start at 48 CSS px with spacing; verify they are reachable at the default reach setting.

The board should dominate the screen. Show a small mode label: Hover, Draw, Move, Eraser readying, Erase, Paused, or Tracking lost. The cursor uses the selected color plus a contrasting outline; mode must not rely on color alone. Display the actual pen diameter or eraser radius in screen space. Hide the hand cursor in pointer mode.

Keep the optional mirrored camera preview outside the board surface. Its skeleton is for positioning feedback, not essential to writing. Preview and developer HUD can update at lower rates than ink. Hiding the preview must not stop inference.

### Starting, writing, and stopping

The hover cursor follows the filtered pen position before pinching. Pinch-down fills it immediately as provisional feedback. A validated pinch starts a stroke at its recorded onset; do not start at a later confirmation point. Release stops ink at the last validated down sample. No line follows the opening fingers. Short validated taps produce dots.

Settings expose Light, Balanced, and Steady stabilization presets. Default to Balanced after tuning. Explain Steady as “steadier movement, more resistance.” Offer a compact advanced slider if useful, not dozens of algorithm knobs in the normal UI. Reach controls the amount of physical movement needed to cover the workspace. New mapping/filter settings apply at the next idle boundary, never halfway through a stroke.

### Hand interaction with controls

Map the hand to the whole interaction surface, including the reserved strip. Resolve control hit regions before board coordinates. A pinch beginning over a control owns that interaction until release and invokes the control once. Crossing onto the board while still pinching must not draw. A drawing pinch crossing onto the strip ends at the last valid board position and cannot activate controls until released. A hover alone never activates a control.

Hand-initiated clear opens the same confirmation UI as pointer clear; release must occur before a confirmation pinch can be accepted. A single held pinch cannot clear the board through both steps.

### Learning and recovery

Offer a skippable, replayable practice sequence: draw a loop, pan, zoom, erase. Use a separate practice board so training cannot erase the real board. Validate actions through domain events, not recognition of a perfect circle. For example: a stroke of at least 40 CSS px, a pan of 40 px, a scale change of 15%, and deletion of the practice stroke. Show checkmarks and concise hints. Start timing after camera readiness. The lesson has roughly 20 seconds of instruction; the usability target is completion within 30 seconds by at least four of five first-time testers.

Pause must stop writing immediately. A visible pause button and P with board focus toggle it; Escape ends the active interaction and leaves input paused. Reserve held Space for temporary pointer panning, so it cannot also toggle pause. After an interrupt, the user releases their hands before writing can resume. Undo remains reachable at all times. Avoid persistent animated banners and unsolicited audio.

## 5. Architecture and module boundaries

```text
Camera capture ── one admitted frame ──> Inference worker
                                             │
                                      timestamped result
                                             │
Replay source ────────────────────────────────┤
                                             ▼
                           validity + identity + features
                                  │                 │
                           pen filtering       gesture evidence
                                  └─────────┬───────┘
                                            ▼
                                   interaction reducer
                                            │
Pointer / keyboard / UI ── commands ─────────┤
                                            ▼
                              board + history + view model
                                            │
                             cached ink + live tail + cursor
                                            ▼
                                   Canvas 2D renderer
```

The reducer consumes each accepted detection in order. The renderer displays the latest resulting state. Do not discard a down/up transition merely because several results arrive before the next animation frame.

Suggested ownership boundaries, not a demand for dozens of empty files:

```text
src/
  app/          composition root, lifecycle, validated configuration
  camera/       permissions, stream ownership, frame admission
  tracking/     worker adapter, protocol, identity, feature extraction
  input/        hand reducer, pointer adapter, keyboard and control routing
  signal/       One Euro, discontinuity checks, transient prediction
  board/        strokes, commands, history, view transforms, hit testing
  render/       geometry, bounded caches, dirty rendering, export
  ui/           semantic controls, onboarding, status, settings
  dev/          metrics, recording, replay; development build only
tests/
  fixtures/     synthetic and consented recorded inputs with metadata
  unit/         domain, signal, geometry, lifecycle contracts
  integration/  protocol, ownership, reducer-to-board behavior
  e2e/          browser workflows and failure paths
  benchmarks/   named workloads and measurement scripts
public/assets/  versioned model and WASM files
docs/           architecture decisions, test map, performance results
```

Core contracts:

| Contract | Required contents and invariants |
|---|---|
| Frame envelope | Session epoch, sequence number, source timestamp, main-thread observation time, image dimensions, owned frame resource. Exactly one owner closes it. |
| Tracking result | Echoed epoch/sequence/timestamp; up to two normalized and world-landmark sets; handedness metadata; backend diagnostics and worker-local duration. No browser API object leaks into the domain layer. |
| Hand observation | Stable application track ID, validity, raw gesture features, mapped pen position, timestamps. Quality is explicitly an app heuristic. |
| Interaction state | Discriminated mode, owner IDs, candidates/timers, provisional stroke ID, reset/release requirements. Mutually exclusive document-editing modes. |
| Stroke | Stable ID, color, world-space width, ordered observed/filtered centerline points, geometry version, bounds, optional corner flags. No predicted points. |
| View | Finite positive scale and finite translation in CSS pixels; world coordinates remain independent of viewport dimensions. |
| Document command | AddStroke, RemoveStrokes, ClearBoard. Commands contain sufficient data for exact undo without copying the entire document per sample. |
| Render snapshot | Document/view versions, active stroke tail, cursor, dirty regions. No direct mutation of document state. |
| Replay record | Schema version, timestamps, dimensions, raw landmarks, scenario metadata, expected events, configuration and backend versions. |

Keep stateful mathematical helpers encapsulated. Keep gesture transitions and coordinate math deterministic with explicit state and timestamps; no hidden `Date.now()`, DOM reads, or timers in the reducer. Use injected clocks and sources. Vendor inference objects stay behind the tracking adapter. UI code dispatches commands and reads summaries; it does not edit stroke arrays.

## 6. Capture, scheduling, and latency control

### Frame admission and ownership

1. Prefer `requestVideoFrameCallback` for new video frames. Feature-detect it; fallback to `requestAnimationFrame` with a changed `video.currentTime` check. Neither path may infer repeatedly on the same frame. The video callback supplies presentation-related metadata, not a guarantee of exact camera-to-screen timing. [API documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).
2. Permit one pipeline operation at a time, including asynchronous bitmap creation and inference. Set busy before creating the bitmap. If busy, skip admission and count it; do not create a queue of images waiting for the worker.
3. When free, snapshot the newest available frame. Transfer its ImageBitmap. The worker closes the received bitmap in `finally`; the sender closes any bitmap whose transfer fails or whose epoch becomes obsolete. Resource release is mandatory. [ImageBitmap.close](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap/close).
4. Results must echo sequence and epoch. Reject old-session, duplicate, out-of-order, non-finite, or stale results. A restart increments the epoch and resets tracking/filter state.
5. Keep model timestamps strictly increasing within a detector session. Use source/media timestamps for sample intervals, not irregular message-arrival intervals. Recreate/reset the detector when a new source starts its timestamp timeline again.
6. Clear busy on every success, explicit failure, termination, and timeout path. A hung worker triggers a bounded recovery attempt, not unlimited restarts.

Start with structured cloning of the tiny landmark payload; optimize it into pooled transferable buffers only if profiling warrants it. Image resources need strict ownership immediately. Small numerical message optimization can wait.

### Worker capability spike

M0 must test real model initialization and several valid inferences inside the deployed worker bundle, not just check for the existence of `Worker` or `OffscreenCanvas`. Verify module-worker loading first. If that exact MediaPipe release requires classic loading, isolate a self-hosted classic-worker adapter with an integration test; do not sprinkle `importScripts` patches through application code.

Probe GPU worker operation, then CPU worker operation. Compare warmed inference, total pipeline time, tracking quality, memory, and thermal behavior before choosing the default. Warm-up samples are excluded from steady-state statistics but initialization time is reported separately. Do not hardcode claims about GPU or resolution making inference faster; model input dimensions may remain fixed.

If a worker path fails, use a supported CPU worker where possible. The guaranteed recovery is pointer mode. Main-thread inference may exist as an explicitly selected compatibility mode only if measured task durations remain acceptable; lowering its rate does not make each synchronous inference non-blocking. Never silently call that mode equivalent to the preferred experience.

### Rendering and adaptation

Rendering follows display cadence independently of detection. A 60 Hz display does not create 60 genuine tracking samples from a 30 fps camera. Draw accepted input promptly, and use bounded preview prediction only where it helps. Do not insert an interpolation buffer that deliberately delays all input by a camera frame.

If performance degrades, first disable skeleton/debug updates and reduce raster scale. Then evaluate a lower input resolution or admitted inference rate using recorded quality results. Keep two-hand detection while claiming two-hand controls. Apply camera/backend changes only at an idle boundary, with release-to-rearm, and use hysteresis to avoid oscillating settings. Never respond to slow tracking by extending prediction far into the future.

## 7. Coordinate systems and hand identity

Use named transformations between: normalized camera coordinates, interaction-surface CSS pixels, board-local CSS pixels, board-world coordinates, and canvas backing-store pixels. Do not mix device pixel ratio with gesture thresholds.

Let camera position be `(u, v)` and the reach rectangle be `[u0,u1] × [v0,v1]`. Mirror once at the input mapping: `uMirror = 1-u`. Map that rectangle to the interaction-surface rectangle. Translate to board-local coordinates only after excluding control regions. For view scale `s` and translation `t`:

```text
screen = world * s + t
world  = (screen - t) / s
backingStore = boardLocalCss * effectiveRasterScale
```

Default reach is the central 70% of camera width and height, with a settings range of 50–90%. Use actual camera dimensions when calculating geometric distances from image landmarks: normalized x and y have different pixel scales on a non-square frame. Define preview crop/letterboxing separately and test it. If a hand leaves the reach region, stop admitting ink; don't clamp ongoing drawing into a long line along the screen edge. Reentry while held does not restart ink until release.

For pinch geometry, world-landmark distances within one hand are useful but remain noisy model estimates, not rotation-proof ground truth. Their origin is the individual hand's center, so never subtract world landmarks from different hands to calculate inter-hand distance. Use mapped screen positions for two-hand transforms. [Coordinate definitions](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker?tab=Web).

Associate at most two hands with existing tracks by comparing the two possible assignments. Use time-scaled wrist/palm proximity, palm size consistency, and weak handedness evidence. Handedness is not a persistent identity. Predict positions only for association with bounded velocity. If assignments are too similar or implausible, declare ambiguity, suspend editing, and reacquire after release. Never silently hand an active stroke to the other person/hand.

The first eligible pinch owns drawing until release. The non-owner hand cannot erase or select controls during that stroke. A newly appearing already-pinched hand must show release before drawing; this prevents lines when returning to the camera. Keep independent filter histories per application track ID. Reset them on identity changes, prolonged loss, source changes, and reach/viewport remapping.

## 8. Handwriting pipeline

### 8.1 Separate measurement cleanup from aesthetic smoothing

Process pen input in this order:

1. Validate finite landmarks and a non-degenerate palm scale.
2. Associate hand identity and classify discontinuities.
3. Compute thumb/index midpoint for the pen; compute gesture features separately.
4. Map the pen to interaction CSS pixels.
5. Apply a timestamp-aware One Euro filter to pen position.
6. Use the gesture reducer to decide whether this observed sample belongs to a stroke.
7. Convert admitted points to world space and construct bounded local stroke geometry.
8. Draw an optional predicted tail in a disposable preview layer.

Do not add a moving average, One Euro, a spring, heavy freehand streamlining, and spline fitting in series by default. Their delays and shape changes accumulate. Each additional stage must earn its place in replay measurements.

### 8.2 Discontinuities and outliers

Reject NaN, infinity, invalid palm scales, reversed timestamps, and impossible cross-track assignments. For plausible coordinate jumps, use a robust residual relative to recent velocity and palm size, with thresholds scaled by elapsed time. Require supporting evidence such as inconsistent palm motion/size or multiple landmark discontinuities before classifying a fast movement as a tracking failure. A high speed or sharp corner alone is not an outlier.

For the first outlier experiment, retain the last seven accepted prediction residuals. Flag a new residual only when it exceeds `max(25 CSS px, 0.5 * mappedPalmSize, medianResidual + 6 * MAD)`, and the independent landmark/palm consistency evidence also fails. These are deliberately conservative seed thresholds; collect false-positive and false-negative results before enabling rejection. Use actual elapsed time in the motion estimate, and treat large gaps through the dropout policy instead of this threshold. Rejecting a point must not contaminate the residual history or coordinate filter.

On suspected discontinuity, freeze the endpoint and mark uncertainty; do not stretch a line to the outlier. If the next valid observation restores continuity, apply the short-gap policy. Otherwise end the stroke at the last trustworthy point and require release. No Kalman filter or median window over the pen coordinates is necessary initially. A constant-velocity Kalman or alpha-beta filter is an experiment only if the baseline fails quantified quality tests.

### 8.3 Adaptive low-pass filtering

Implement the One Euro equations using seconds for `dt` and CSS pixels for coordinates:

```text
alpha(f, dt) = 1 / (1 + 1 / (2*pi*f*dt))
d            = (x - previousFilteredX) / dt
filteredD    = lowPass(d, alpha(derivativeCutoff, dt))
cutoff       = minCutoff + beta * abs(filteredD)
filteredX    = lowPass(x, alpha(cutoff, dt))
```

Apply the same process independently to x and y initially, matching the chosen reference implementation. A shared vector-speed cutoff is a separately tested variant, not an undocumented change. Initialize the filter to the first valid sample rather than zero. Reject duplicate/reversed timestamps; reset on a large gap. Do not feed repeated samples every render frame, because that changes the filter response without new evidence. The authors describe the speed-dependent jitter/lag tradeoff and the dependence of beta on input units. [Algorithm and tuning](https://gery.casiez.net/1euro/), [TypeScript reference](https://github.com/casiez/OneEuroFilter/blob/main/typescript/src/OneEuroFilter.ts).

Starting experiment values, not validated presets:

| Setting | Light | Balanced | Steady |
|---|---:|---:|---:|
| Minimum cutoff, Hz | 2.5 | 1.5 | 0.8 |
| Beta for CSS-pixel input | 0.030 | 0.020 | 0.015 |
| Derivative cutoff, Hz | 1.0 | 1.0 | 1.0 |

Tune minimum cutoff on stationary and slow traces first, then beta on fast traces. Keep endpoints and corners in the evaluation. If these seeds miss the acceptance targets, change them using evidence; do not silently redefine the targets. Stronger filtering can suppress some shake but must not pretend to reconstruct an intended path from arbitrary large hand movements.

### 8.4 Pinch onset and release

Use a small provisional sample buffer beginning at the first valid pinch-threshold crossing. Show provisional ink promptly while the candidate is validated. If it confirms, retain its onset and all admissible samples. If it fails, remove only the provisional preview. Do not erase previously committed ink.

Keep the coordinate filter warm during hover. Pinch midpoint motion can still produce onset artifacts; compare midpoint and a continuity-compensated midpoint in fixtures before adding compensation. Default to the simpler midpoint if both pass. Never fix artifacts by dropping a fixed number of samples or connecting pre-pinch hover positions into the stroke.

A confirmed down/up sequence whose displacement is below the sampling threshold becomes a round dot. An unconfirmed one-sample false pinch is discarded. After pen-up, preserve the last valid down endpoint; do not append the coordinates of the opened hand and do not snap the final point to an unfiltered measurement.

### 8.5 Geometry and corners

Use round joins/caps and a constant brush width. The selected width is expressed in CSS pixels at stroke start and converted to world units using that start scale; existing ink scales with subsequent zoom. Freeze width and color within a stroke.

Keep the first and final point, meaningful direction changes, and any sample at least 0.5 CSS px from the last retained point. Retain a live endpoint even below this spacing. This threshold is measured at creation scale and is a tuning seed. It should not destroy tiny punctuation or create memory growth while a pen is stationary.

For smooth runs, use incremental quadratic segments through successive midpoint joins, keeping only the newest segment provisional. Begin at the actual first point and end at the latest filtered point. At a strong direction reversal or corner, preserve the vertex with joined line/curve segments rather than rounding across it. Start corner evaluation at a 60-degree direction change with sufficient segment lengths; tune against acute-angle fixtures. A curve must not invent loops or overshoot a corner.

Retain sufficient vector geometry to redraw identically after zoom, undo, and export. Do not run full-stroke outline generation every animation frame. Do not replace the whole stroke with visibly different geometry on release. Post-commit simplification is deferred unless the point-budget benchmark requires it; if introduced, preserve endpoints/corners and bound deviation at the maximum supported zoom.

### 8.6 Optional prediction

Prediction is a visual experiment behind a flag until it passes quality tests. It is never used for pinch decisions, hit tests, erasing, toolbar activation, stored stroke geometry, history, or export.

Estimate velocity from recent filtered observed samples. At render time use `h = clamp(softwareResultAge + estimatedWaitToNextDisplay, 0, min(16 ms, medianSampleInterval/2))`, with a zero display-wait estimate when no reliable estimate is available. Extrapolate by `velocity * h`, then clamp projected distance to 6 CSS px. These are initial upper bounds. Estimate software result age from the main-thread frame-observation time; do not claim knowledge of unmeasured sensor delay or assume this compensates the filter's entire lag.

Reduce prediction toward zero at slow speeds, stops, large turns, unstable acceleration, pinch transitions, stale results, or low-quality/ambiguous tracking. Start with no prediction for the first two valid samples of a stroke. Clear it immediately on release or loss. Render from the last confirmed endpoint into a disposable tail, replacing it each frame. Keep the cursor at the same displayed tip so feedback and ink agree.

Do not predict indefinitely between frames. After one expected sample interval without a new result, freeze the preview; once the stale threshold is reached, show tracking loss. If predicted strokes overshoot more than the allowed error, disable prediction rather than conceal the failure through heavier filtering.

## 9. Gesture state machine

Use explicit states: Disabled, Hover, PinchCandidate, Drawing, Transforming, EraseArming, Erasing, TrackingSuspended, and AwaitRelease. UI capture is an input-routing state with priority over new board actions. Pause/lifecycle interrupts override everything. Only one document-editing mode is active at a time.

Initial tunables below must live in validated configuration with units. They are seed values, not factual universal thresholds:

| Parameter | Initial value | Semantics |
|---|---:|---|
| Pinch-down ratio | 0.25 | Thumb-tip/index-tip world distance divided by wrist/middle-MCP distance. |
| Pinch-up ratio | 0.40 | Hysteresis; must exceed down threshold. |
| Down confirmation | 20 ms and two valid samples | Feedback begins on candidate; commit eligibility follows confirmation. |
| Pen-up | First reliable sample above up threshold | Stop adding ink immediately; prioritize avoiding release tails. |
| Two-hand joining window | 250 ms | Only affects an early, short provisional stroke. |
| Transform rollback path limit | 16 CSS px | Longer first-hand strokes are preserved, not silently discarded. |
| Minimum transform separation | 40 CSS px | Avoid division by tiny distances and unstable zoom. |
| Fist arming | 180 ms | Require a stable eligible fist and visible progress. |
| Short dropout | At most 80 ms | Reconnection requires all continuity checks below. |
| Reconnection distance | At most 8 CSS px | Also require same unambiguous identity, valid pinch, and plausible motion. |
| Stale-result rejection | More than 100 ms since frame observation | Treat as loss, not fresh input. Report separately from camera delay. |
| Scale limits | 0.1–10 | Apply clamp before recomputing translation. |

Timing uses timestamps, not a count of render frames. At low camera rates, two-sample confirmation naturally takes longer; measure and report that limitation. Thresholds remain separate from the continuous pen filter. Pinch eligibility also requires a plausible thumb/index pinching pose; thumb/index proximity inside a closed fist alone must not create pen-down. Ambiguous poses remain hover or suspended input. Do not add another long debounce in the UI.

### Transition rules

| Situation | Required behavior |
|---|---|
| Eligible open hand becomes pinched over board | Enter candidate, show provisional ink, validate and preserve onset. |
| Candidate fails before confirmation | Remove provisional ink; return to hover. |
| Drawing hand releases | Commit one stroke, including a dot when appropriate; return to hover. |
| Second hand pinches while first stroke is early and short | Cancel only that provisional stroke; start transform. No history entry for the canceled mark. |
| Second hand joins after first stroke has meaningful movement | Finalize the first stroke and start transform if both hands are eligible; never erase intentional writing. |
| Both hands begin pinching in the same result | Start transform directly; no transient document stroke. |
| Transform loses either pinch or a hand | Freeze view, enter AwaitRelease; both participants must release before drawing resumes. Missing hands cannot count as observed release. |
| Eligible owner forms a fist while no draw/transform/UI capture is active | Enter EraseArming; show progress; activate only after continuous validity. |
| Fist breaks, disappears, becomes ambiguous, or enters control area | Stop erasing immediately; do not continue through a gap. |
| Tracking loss during drawing | Freeze endpoint and prediction immediately; hold a suspended interaction briefly, then close it if continuity cannot be proven. |
| Hand identity is ambiguous | End/freeze the current interaction conservatively; require reacquisition and release. |
| Pause, blur, resize, source change, or camera stop | Close valid ink at its last trustworthy sample, clear provisional previews, cancel eraser/transform, reset capture ownership. |

For short draw gaps, reconnect only if every stated time, distance, identity, and pinch check passes. Missing data is never interpolated into invented curves. If the hand returns too far away, end the original stroke and wait for release. Short-gap policy is configurable for experiments; default to splitting if tests show false bridges. Expire an absent track after a proposed 250 ms rather than retaining a missing transform participant forever. Expiration ends its ownership; it does not count as a pinch release. A returning/new track must show a valid open-hand observation before it becomes eligible. Include a regression test for resuming one-handed use after the other hand leaves entirely.

Fist detection must combine finger joint bend angles with tip-to-palm relationships for index, middle, ring, and pinky. The simple “tip closer to wrist than PIP” check alone is insufficient under rotation. Start with conservative configurable angle thresholds and validate with rotated, partly curled, and pinching hands. During active drawing, a second hand's fist has no effect. If reliable fist detection cannot meet the safety gate, keep an explicit eraser tool available and leave the fist gesture disabled until repaired.

### Two-hand transform mathematics

At transform start, store screen midpoint `m0`, separation `d0`, view `(s0,t0)`, and world anchor `w0 = (m0-t0)/s0`. At each valid update:

```text
sNew = clamp(s0 * d/d0, 0.1, 10)
tNew = m - w0*sNew
```

Use the clamped scale in translation. This keeps the initial world anchor underneath the current midpoint during simultaneous pan and zoom. Do not add rotation or inertia. When separation drops below the usable limit, freeze scale while allowing valid midpoint panning, then rebase the reference when separation becomes usable; test that rebasing is continuous. Never use per-hand-centered 3D world positions for `d`.

## 10. Board, rendering, erasing, and history

### Canonical board and renderer

Store vector strokes in world coordinates. Raster layers are disposable caches, never the document. Maintain an opaque visible Canvas 2D context, requesting `desynchronized: true` and `alpha: false` on first creation. Read supported context attributes where available. Fall back gracefully. Avoid `willReadFrequently` on the board; keep pixel-read diagnostics on a separate low-resolution surface if ever needed.

Render cached committed strokes, the active stroke, and cursor/feedback. Use a bounded offscreen canvas or detached canvas for caching. Raster scale begins at `min(devicePixelRatio, 2)` with a total cache-memory cap; reduce it if needed for large windows. Cache size depends on the viewport, not the infinite world's extent.

Normal drawing appends new committed ink to a valid cache. Erase/undo/clear invalidate appropriate regions or trigger a bounded rebuild. Resize, DPR, style, and view changes invalidate cache versions explicitly. During pan/zoom, reuse a transformed snapshot for immediate feedback, then render crisp vectors. Newly exposed areas must progressively render while the gesture continues; a screenshot of the old viewport cannot represent unseen strokes.

Large rebuilds use short chunks and cancel when the document/view version changes. Never swap a stale completed cache into a newer document. Paint a complete background/cache composition without an intermediate blank visible frame. Schedule frames only while dirty, interacting, or animating a necessary indicator; a completely idle board needs no endless full redraw.

### Erasing

Erase whole strokes in this release. Show a fixed 24 CSS px radius initially and convert it to world units by dividing by the current scale. Include stroke width in collision checks. Broad-phase: intersect the swept eraser bounds with stroke bounds. Narrow-phase: capsule-versus-centerline segment distance, including single-point dots and curve flattening to a bounded screen-space error. Checking only sampled points misses crossings between samples.

Sweep between successive valid eraser positions to avoid tunneling. Never sweep across a tracking gap. One continuous erase gesture produces one history command, even if it removes many strokes. Repeated hits on the same stroke are deduplicated. Hover/arming never deletes anything. A unit test must establish agreement between the visible eraser radius and the hit-test radius at different zooms.

### History and bounds

Undo/redo operates on user actions: one stroke, one erase gesture, or one clear. Pan/zoom and settings are not document history in this release. New edits after undo clear redo. Commands preserve original stroke ordering. Clear is one reversible command after confirmation, not a destructive reset of history.

Support Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, with Z/Shift+Z shortcuts when the board has keyboard focus. C opens clear confirmation only with board focus. Do not hijack shortcuts in inputs, sliders, dialogs, or browser/system contexts. Holding a key must not repeatedly clear or toggle pause.

Initially cap undo at 100 actions and 16 MiB of retained undo payload, evicting the oldest undo data without deleting current board content. Share immutable stroke data instead of repeatedly copying it. Target 100,000 stored points and 500 strokes as the normal benchmark workload; set a hard guard at 500,000 points or 5,000 strokes. At the guard, preserve existing work and offer export/clear; do not silently delete or aggressively simplify ink. Large individual strokes use chunked point storage and remain one undoable action.

### Export

Export a PNG of the current viewport with white background and current view transform. Include committed ink and a finalized valid active stroke, but no cursor, prediction, guides, debug data, camera preview, or controls. Capture a consistent board/view version and render to a dedicated export surface. Default to the visible raster size; do not allocate an enormous canvas from world bounds. Handle null/failed blob creation and release object URLs after download. Export changes neither history nor the view.

## 11. Lifecycle, privacy, accessibility, and deployment

Use explicit application states: idle, requesting camera, loading model, warming, ready, paused, recovering, and failed. A single lifecycle owner starts and disposes streams, worker, callbacks, listeners, caches, and pending operations. Initialization and teardown must be idempotent. Cancelled asynchronous starts may resolve later; immediately stop their tracks and discard their results.

When hidden or unfocused, suspend editing and inference immediately. On `pagehide` or explicit Stop, stop all camera tracks and close the detector/worker. For a hidden tab lasting more than 30 seconds, also stop the camera; returning then requires an explicit restart. A short blur may retain the stream but requires deliberate Resume and release-to-rearm. Freeze/commit valid partial ink before suspension. Handle camera unplug, track-ended events, worker crash, graphics-context failure, and device switch without clearing the board.

Camera frames and landmarks stay local. Host model/WASM assets on the application origin; do not contact third-party CDNs at runtime. No analytics, crash uploads containing input, WebSocket, or backend endpoints are needed. Allow explicit local debug recording only in development, with a visible recording indicator, bounded duration/size, stop, discard, and export. Default recording contains landmarks and configuration, not camera video. Raw test videos require separate explicit consent and stay local. Production builds omit developer recording and replay UI.

Serve over HTTPS, with correct WASM MIME type and stable asset URLs. Test a production build under a subpath, not only Vite's dev server. Use a restrictive Content Security Policy compatible with the chosen WASM/worker loader; don't add broad allowances to make errors disappear. Restrict camera permission policy to the app and disable microphone permission. Use hashed/versioned immutable asset caching and explicit load-failure retry. Do not add cross-origin isolation requirements unless a measured optimization actually needs them.

Controls must support keyboard navigation, visible focus, accessible names, sufficient contrast, and screen-reader state changes. Announce mode changes sparingly, not every landmark update. Respect reduced-motion preferences. Pointer mode supports pointer capture, release outside the canvas, cancellation, and one active pointer owner. Consume coalesced pointer samples when available, with ordinary pointer events as fallback; they are observed input, unlike predicted samples. Pointer input bypasses the hand-specific noise filter and uses the same geometry/document pipeline. Provide pointer pan via Space-drag or a visible move tool, and pointer zoom with wheel/trackpad while the board is focused. Anchor zoom at the pointer using the same view math. Prevent page scrolling only while the board owns that wheel interaction. Canvas drawings themselves are not automatically semantically accessible; don't claim full nonvisual access to handwritten content.

## 12. Performance budgets and how to measure them

These are proposed release gates, not existing benchmark results. Designate one baseline demo laptop and one slower comparison laptop in M0. Record CPU/GPU, OS, camera, browser, power mode, display refresh, viewport, DPR, delegate, actual camera settings, model checksum, and package versions. Missing hardware evidence is “not measured,” not “passed.”

| Metric | Initial target | Measurement |
|---|---|---|
| Shell payload | At most 150 KiB gzip for first-party JS/CSS | Excludes separately reported ML assets; inspect production output. |
| Total cold camera-mode payload | Target at most 20 MiB compressed | Include ML JS, WASM, model; report actual total even if target fails. |
| Interactive shell | Within 1 s on baseline warm navigation | Measure board and controls available independently of model readiness. |
| Ready after permission | Within 3 s with cached assets; within 10 s on a defined 25 Mbps cold profile | Report loading and warm-up separately; permission-decision time excluded. |
| Tracking throughput | At least 30 accepted results/s when actual camera cadence supports it | Use a continuous two-hand workload; no claiming 60 Hz render rate as tracking rate. |
| Inference | p95 at most 15 ms on baseline preferred backend | Worker-local call duration after warm-up; CPU fallback reported separately. |
| Frame observation to draw submission | p95 at most 40 ms | Main-thread timestamp at admitted frame callback to canvas submission using its result; excludes unknown sensor/display latency. |
| Input math + reducer | p95 at most 1 ms per accepted result | Measured independently from inference/render. |
| App main-thread work per active display frame | p95 at most 8 ms at 60 Hz | Includes app input handling, drawing, and UI work in that interval. |
| Steady rendering | p95 at most 4 ms on normal workload | Separate from cache rebuilds and export. |
| Cache rebuild chunk | At most 4 ms of app work per chunk | No unbounded synchronous rebuild after a large erase or zoom. |
| Sustained frame cadence | At least 95% of active rAF intervals within 20 ms on 60 Hz baseline | Record browser scheduling limitations; test with and without screen sharing. |
| App long tasks | None over 50 ms during steady writing | Initialization/export reported separately; investigate all recurring long tasks. |
| Physical motion to visible ink | Target p50 at most 80 ms and p95 at most 120 ms | External high-frame-rate recording of hand and screen, at least 30 identifiable events. |
| Physical pinch to visible start | Report separately; target p95 at most 150 ms | Includes gesture confirmation, camera, and display. |
| Frame queue | At most one admitted operation; no pending image backlog | Instrument admission/snapshot/inference ownership. |
| App raster caches | At most 64 MiB calculated backing-store storage | Report model/browser/GPU memory separately. |
| Leak behavior | Stable retained-resource counts; no sustained growth after identical cycles | Twenty start/stop cycles and a 15-minute session; compare equivalent post-cleanup states. |

For a 30 fps camera, report the measured cadence rather than treating small timestamp variation around 30 as a product failure. The throughput gate is subject to actual supplied frames; the app must not manufacture duplicates to hit a number. Lower-end mode can have different results, but must be visibly identified and cannot be used to claim the primary gate passed.

Calculate percentiles from raw samples across at least three 60-second warmed runs. Also run a 15-minute thermal/soak test. Keep p50, p95, p99, sample counts, and maximum. Don't add p95 values from different stages and call the sum an end-to-end p95. Main and worker `performance.now()` values can have different origins: use same-context durations and main-thread round trips, or explicitly align origins before cross-context subtraction. `mediaTime` has a different clock again.

The debug HUD updates at no more than 4 Hz and shows source fps, admitted frames, accepted results, busy skips, invalid/stale results, inference percentiles, result age, draw-submission latency, render duration, active backend, active tracks, and cache/point counts. Separate camera-frame skips from inference errors and identity failures. Label internal timing “software pipeline,” never “true frame-to-pixel.” Validate physical latency with prediction both off and on; prediction changes appearance, not sensor information latency.

## 13. Feature-to-test acceptance matrix

Every row is required. Use deterministic tests for correctness, browser tests for integration, and human/hardware tests for properties that automation cannot establish. Implement tests with the feature, not as a final cleanup task.

| ID / feature | Automated tests | Human or performance acceptance |
|---|---|---|
| F01 Startup and pointer-only entry | Load without media APIs; shell usable before model loads; no permission request before Start; no model download in pointer mode | A user can draw immediately without a camera. |
| F02 Camera permission/errors | Resolve, reject, leave pending, cancel, double-click Start; denial, unavailable device, busy device, insecure context | Each case has the right explanation and a working retry/fallback. |
| F03 Camera selection and teardown | Switch devices; late getUserMedia completion; stop during loading; track-ended; twenty start/stop cycles | Camera indicator goes off after Stop; no duplicate streams/workers or lost board. |
| F04 Model loading and worker compatibility | Production asset URLs, corrupt/missing model, timeout, module/classic adapter as used, GPU failure/CPU path, no CDN fetches | Real camera/model runs on every supported demo machine. |
| F05 Admission and freshness | Slow inference, async snapshot delay, stale epochs, duplicate timestamps, reversed results, worker hang; assert one operation and resource closure | Overload drops admission rather than building latency. |
| F06 Mapping and reach | Corners/center, mirrored exactly once, 4:3 and 16:9 input, DPR 1/2, sidebar offset, resize, out-of-reach | User reaches every control without shoulder-extreme movement; no edge-clamped lines. |
| F07 Hand ownership | Reverse detector ordering, cross hands, disappear/reappear, handedness changes, second person's hand | No active stroke transfers owners; uncertainty safely interrupts. |
| F08 Hover and cursor | Ring position/diameter/color, mode changes, no drawing on hover, no stale/predicted cursor after loss | Cursor and visible ink endpoint agree; readable on all palette colors. |
| F09 Pinch drawing | Threshold oscillation, confirmation timing, open/close, held pinch at acquisition, short taps, long strokes, false candidates | No flicker or stray starts in a five-minute writing session. |
| F10 Onset, dots, and endpoints | Validated single-dot traces, i/j dots, decimal points, tiny minus sign, release motion; first/last-point invariants | Small punctuation survives; no opening-finger tails. |
| F11 Stabilizer | Reference vectors, irregular dt, duplicate times, resets, all presets, noisy lines/curves/corners | Meets signal-quality gates below; user can distinguish useful presets. |
| F12 Discontinuity protection | Inject isolated outliers, multi-landmark jumps, valid fast sweeps, sharp corners | Reject tracking jumps without routinely deleting intentional fast strokes. |
| F13 Optional prediction | Bounded horizon/distance, stop/turn, first samples, release/loss, serialized board equality with flag off/on | Ship enabled only if perceived improvement and overshoot gate both pass. |
| F14 Two-hand mode arbitration | Simultaneous pinch, second pinch before/after grace window, path-limit boundary, release, ambiguous hand | No unexplained deleted writing or phantom stroke after transform. |
| F15 Pan and zoom math | Anchor invariance, scale clamps, tiny separation, rebase, no rotation; randomized transform sequences | Midpoint anchor stays visually fixed; no jump when exiting zoom. |
| F16 Infinite board and view controls | Pan beyond initial viewport; old content appears; fit/reset empty and populated board; resize at zoom | Board remains crisp after settling, with no missing newly exposed content. |
| F17 Fist arming | Partial curls, rotation, draw/fist conflicts, arming interruption, false-fist fixtures | Zero unintended erase activations in five minutes per tester, at least three testers. |
| F18 Eraser hit testing | Sparse segment crossing, thick lines, curves, dots, grazing miss, swept motion, zoom, tracking gap | Radius matches deletion; one gesture removes intended strokes and undoes once. |
| F19 Dropout/reacquisition | Gaps of 33/66/100/250 ms, close/far return, pinch release during gap, unknown identity, stale results | No long bridges or writing on reentry while still pinched. |
| F20 Color and size | Each color/width, mid-stroke setting change, world width at zoom, selection state | New strokes use the choice; existing strokes remain unchanged. |
| F21 Hand-operated controls | Pinch starts over control, drags into board, held pinch, hover, drawing enters strip, clear confirmation | Exactly one action per pinch; no toolbar click leaves ink. |
| F22 Undo and redo | Add/erase/clear, repeated undo, redo invalidation, stroke order, empty history, payload/action caps | Repeated recovery produces the exact expected board. |
| F23 Clear | Confirm/cancel by keyboard, pointer, and hand; held pinch cannot confirm twice; undo clear | No accidental immediate loss from C or a single hand pinch. |
| F24 Pointer/keyboard fallback | Capture/release outside board, pointercancel, tool change, Space-drag, anchored wheel zoom, focus restrictions | Complete board workflow without camera or hand gestures. |
| F25 Pause and lifecycle | Pause while drawing, blur, hidden tab, pagehide, camera stop, resume/release, timeout | No hidden-tab strokes, stale gesture, or cleared work after recovery. |
| F26 Tutorial | Every event condition, skip/replay, isolated practice board, return to original board | At least 4/5 new users complete four gestures within 30 s after readiness. |
| F27 Settings | Validate bounds, atomic preset changes at idle, reset defaults, no active-stroke discontinuity | Reach and smoothing are understandable without a developer explanation. |
| F28 Preview and accessibility | Toggle preview without inference loss, labels/focus/pressed states, keyboard traversal, live-region rate, reduced motion | Controls work with screen reader and keyboard; preview agrees with mirrored movement. |
| F29 Rendering/cache correctness | Add/erase/undo invalidation, stale rebuild cancellation, DPR/resize, long stroke, offscreen content, geometry snapshots | No blank flashes, commit-time shape changes, or growing frame cost with stroke duration. |
| F30 PNG export | Dimensions/background, transformed strokes, exclude overlays/prediction/video, empty board, blob failure, URL cleanup | Download matches the visible board ink and preserves app state. |
| F31 Privacy and production packaging | Network allowlist, zero media uploads, no third-party assets, no debug recording UI/code entry point; storage remains unused | Visible camera/recording status matches reality; runtime works after assets load without network. |
| F32 Recording and replay | Version/schema/size validation, stable timestamps, deterministic outcomes, stop/discard, corrupt input, playback speeds | Developers reproduce a reported gesture bug from a local trace. |
| F33 HUD and metric accuracy | Known synthetic durations, percentile calculation, source/inference/render counts, clock domains, HUD off behavior | Profiler agrees with instrumentation within stated timer limitations. |
| F34 Resource and board limits | History caps, document limits, huge stroke, export under cap, closed bitmaps, cancelled work | Normal-workload and soak gates pass; limit behavior preserves work. |
| F35 Compatibility/deployment | Production build smoke test, subpath routing/assets, missing features, backend fallback, CSP, permission policy | Camera flows verified on named Chrome/Edge targets; other browsers degrade clearly. |
| F36 Complete demo | Automated replay of demo commands and expected final board | Five consecutive 90-second live runs without a broken interaction, reload, or accidental erasure. |

## 14. Test fixtures, numerical oracles, and validation rules

### Synthetic fixture suite

Generate fixtures with a fixed seed and known ground-truth paths. Include stationary points with 1/2/4 px noise, straight lines at 100/400/800 CSS px per second, circles with 20/50/100 px radii, small loops, sine waves, 45/90/135-degree corners, zigzags, abrupt stops, reversals, and isolated jumps. Simulate 15/30/60 Hz observations, jittered sample intervals, duplicate timestamps, and specified dropped intervals. Include letters and math-like marks as stored paths, without adding handwriting recognition.

Replay at a canonical 1280×720 interaction surface, then repeat mapping/geometry checks at other sizes. The same sample timestamps must produce the same domain events and document regardless of 0.5×, 1×, or accelerated playback. Rendering can differ in frame count; committed state cannot.

Balanced-mode initial signal acceptance targets:

| Measurement | Proposed gate and definition |
|---|---|
| Stationary noise | At least 50% reduction in radial RMS error versus the same raw trace, after a 0.5 s warm-up, for the 2 px independent-noise fixture. |
| Temporal lag | At most 25 ms median additional lag on the moving traces; report each speed separately. Estimate best time shift against ground truth, not distance error alone. |
| Shape fidelity | After accounting for measured lag, p95 spatial error at most 3 px on standard paths; report corners separately. |
| Corner preservation | Vertex displacement at most 4 px on the standard corner fixtures; no invented loops or clipped reversals. |
| Endpoints | Filtered committed endpoints preserved exactly by geometry/serialization; no release-induced displacement. Ground-truth endpoint error reported separately. |
| Prediction overshoot | At most 3 px beyond the ground-truth turn/stop on the standard suite; zero persisted predicted points. |
| Dot preservation | Every validated dot fixture remains one visible stroke; every invalid candidate produces none. |
| False connections | Zero cross-identity or prohibited-gap bridges across the fixture suite. |
| Transform precision | Anchor error below 0.01 CSS px in pure math tests and below 1 CSS px in visual replay at supported scales. |

These numerical targets are engineering choices, not guarantees supported by a paper. Real camera traces have no exact intended-path oracle, so combine synthetic ground truth with visual comparisons and user trials. If smoothing cannot meet both lag and jitter targets with one preset, report the tradeoff and tune or revise the preset transparently; do not use prediction to hide failure of the measured committed path.

### Recorded fixture suite

Collect short, explicitly consented landmark recordings covering left/right hands, different hand sizes and skin tones, frontal and rotated poses, two-hand approaches, overlap, low light, sleeves, partial occlusion, near/far camera distance, and genuine hand shake. Keep a few poor-quality examples to exercise recovery. Add hand-labeled expected mode intervals and known failure events. Split tuning traces from held-out regression traces so thresholds are not fitted to the entire test set.

Landmark replay tests the app downstream of inference. It does not validate detector accuracy or camera integration. Add a small local video integration suite and real-camera tests for the pinned model. Likewise, mocked camera tests do not establish GPU worker compatibility. Playwright supports controlled browser API mocks for failure cases; keep those tests distinct from the real integration suite. [Playwright guidance](https://playwright.dev/docs/mock-browser-apis).

### Test discipline

Prefer assertions about behavior and invariants to snapshots of internal implementation. Verify geometry numerically where possible; use visual image comparisons for rendering differences with a documented anti-aliasing tolerance. Do not expect GPU inference to be bit-identical across machines. Test the domain with fixed landmarks and the backend with reasonable validity/accuracy tolerances.

Important invariants include: no document mutation during hover/pause/arming; one active owner; no predicted data in history; exact undo/redo restoration; bounded resources; finite transforms; monotonic accepted timestamps; and all rejected candidates leaving committed content untouched. Randomized event sequences should assert these invariants using a fixed seed.

Standard checks: strict typecheck, lint, unit/integration tests, production build, browser smoke suite, then the relevant targeted hardware benchmark. Every bug fix adds the smallest fixture that reproduces it. Keep timing-sensitive gates on the designated hardware, not an arbitrary shared CI runner. CI can enforce size, correctness, protocol, and regression bounds; headless CI does not prove physical latency or usability.

## 15. Milestones and exit gates

Build vertical slices in this order. Keep the app usable after each milestone. Replay and measurement begin early because they determine the design.

| Milestone | Build | Exit evidence |
|---|---|---|
| M0: Feasibility and contracts | Vite/TS shell; pointer-only board stub; camera lifecycle; actual worker inference; GPU/CPU comparison; one-hand overlay; protocol; basic metrics; fixture loader | Production-worker compatibility on target machines, measured asset sizes/startup/inference, ownership/teardown tests, documented backend decision. No polished UI required. |
| M1: Writing quality | Mapping/identity, pinch reducer, provisional onset, dots, One Euro, incremental ink, replay experiments; prediction evaluated separately | F06–F13/F19 invariants and signal gates; five-minute live writing trial; side-by-side raw/filtered results; no lost punctuation. |
| M2: Board and navigation | World-space document, view math, two-hand arbitration, pan/zoom, bounded cache, pointer pan/zoom, reset/fit | F14–F16/F29; anchor tests; no phantom strokes; newly exposed content renders; normal board workload remains responsive. |
| M3: Editing and recovery | Fist arming, swept whole-stroke eraser, history, clear, pause, lifecycle interruption | F17–F25; zero accidental erase trial; exact undo/redo; interrupt/reconnect tests; no board loss. |
| M4: Complete usable interface | Semantic toolbar, hand control routing, settings, tutorial, preview, accessibility, PNG export | F20–F30, new-user trial, pointer-only completion, export correctness. |
| M5: Release validation | Full replay corpus, production privacy checks, debug stripping, resource/thermal benchmarks, deployment smoke, demo rehearsal | All F01–F36 rows have evidence; named hardware gates passed or explicitly unresolved; five successful live demos. |

On the initial implementation turn, complete M0 as the first concrete slice. Record its evidence before expanding into M1. Do not treat scaffolding as completion of the product. If implementation is authorized to continue, work through the remaining milestones sequentially; only stop for a genuine blocker or an unresolved product decision, not for routine dependency or coding choices.

At each milestone report: completed behavior, checks actually run, measured performance with hardware/context, failures or unmeasured claims, and the next constrained step. If a release gate fails, profile the responsible stage and fix it before layering on more features. Do not silently weaken acceptance criteria to get a green report.

## 16. Code quality and handoff requirements

Write focused, refactorable code with small explicit interfaces. Prefer the simplest implementation that satisfies the tests and performance budget. Avoid speculative plugin systems, a universal event bus, or deeply generic abstractions. Extract a module when it has a distinct responsibility or independent test boundary, not to satisfy an arbitrary file count.

Use discriminated unions for modes and worker messages, exhaustive switching, typed coordinate spaces, and validated configuration. Numerical parameters include units and documented bounds. User settings expose only useful product choices; advanced tuning stays in a development panel. Apply changes through a single validated config path and include config versions in recordings.

Keep pure math and reducers independent of MediaPipe, DOM, and Canvas. Use mutation deliberately within owned typed-array buffers where it reduces hot-path cost; keep document command semantics clear and externally immutable. Allocate stroke/history objects at logical boundaries. Reuse small working buffers, avoid per-frame full-array copies, and never retain frame images in a history/debug structure accidentally.

Comment non-obvious mathematics, ownership, clock-domain conversions, and compromise decisions. Don't comment every line. Error messages should identify the failing capability and recovery action. No swallowed exceptions, perpetual retry loops, unsafe casts to silence protocol mismatches, or production logging of camera-derived data.

Deliver a README with setup/build/test commands, controls, privacy behavior, browser support, known limitations, and demo steps. Include concise architecture decisions for worker packaging, backend choice, smoothing preset selection, coordinate mapping, renderer strategy, and fallback behavior. Include a requirement-to-test map using F01–F36 and a performance report with raw measurements or links to local benchmark artifacts.

The release is complete only when the defined behavior is implemented, tests pass, the production build is exercised, and hardware/user evidence supports the claims. Never describe a planned test as executed, a synthetic replay as a real-camera test, a render-loop frame rate as tracking throughput, or a software timestamp as physical camera-to-pixel latency.

---

End of implementation prompt. The key architectural rule is to keep observation, intent, document state, and visual prediction separate. That separation makes handwriting quality tunable, failure behavior predictable, and future refactoring manageable.
