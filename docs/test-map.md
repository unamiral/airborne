# Requirement-to-test map (F01–F36)

Legend for the human/hardware column: **not measured** means no evidence was
collected (it is not a pass). "Synthetic" means seeded synthetic data or the
Chromium fake camera, never a real camera or a person.

Test locations: `tests/unit/*.test.ts`, `tests/integration/*.test.ts` (Vitest,
Node); `tests/e2e/*.spec.ts` (Playwright, production build under
`/air-whiteboard/` with deployment headers); `tests/e2e/bench/*.spec.ts`
(Playwright, bench build with dev instrumentation); `tests/benchmarks/*`
(hardware benchmarks, Chromium new-headless with ANGLE Metal).

| ID | Automated evidence | Human / hardware acceptance |
|---|---|---|
| F01 Startup, pointer-only | e2e/startup: board usable with no getUserMedia call and no model/WASM/worker request; loads without media APIs; production subpath + headers | Not measured: "user can draw immediately" with a person (automated drawing passes) |
| F02 Camera permission/errors | unit/camera-source (classification, constraints, insecure/unsupported without prompting); integration/camera-session (denial, double start, cancel during prompt); e2e/camera-errors (deny, not found, busy, insecure, pending + cancel, double click, retry after denial) | Explanations reviewed by the developer only; not user-tested |
| F03 Camera selection/teardown | integration/camera-session (20 start/stop cycles, late stream, stop during load, unplug, recovery); bench/release (20 browser cycles: no workers, no live tracks, heap +0.24 MiB); bench/camera-switch (two fake devices: new epoch, same tracker, board kept); e2e/camera-real (Stop releases the track); bench/hand-ui (unplug keeps board) | Switching between real cameras and the hardware camera indicator: **not observed** |
| F04 Model loading/worker | e2e/camera-real (production worker, local assets, CSP, no CDN); integration/tracker-client (GPU→CPU fallback, software-GL detection, timeout, abort, crash, integrity error); unit/init-errors; integration/camera-session (damaged model) | Real camera + model on the designated demo machines: **not measured** (fake camera on the dev machine only) |
| F05 Admission/freshness | integration/frame-scheduler (one op, newest skipped frame, duplicates, obsolete bitmaps closed, failures); integration/tracker-client (late/malformed results, transfer failure); unit/protocol; integration/hand-input (stale → loss) | Overload behavior measured on the dev machine: 0 image backlog by construction |
| F06 Mapping/reach | unit/mapping (corners, single mirror, isotropy, 4:3/16:9, out of reach, reach range, letterboxing); e2e/interface (every hand target ≥ 48 px and inside the 1280×800 surface); bench/hand-ui (controls reached on the real layout) | Reach comfort with a person: **not measured** |
| F07 Hand ownership | unit/identity (reordering, crossing, ambiguity, handedness, second person, expiry, reacquisition); replay-scenarios (second person, early/late join) | **Not measured** with real hands |
| F08 Hover/cursor | integration/hand-input (position, diameter, color, modes, no cursor after loss, blocked cursor) | Readability on all palette colors: reviewed in screenshots only |
| F09 Pinch drawing | unit/hand-reducer (hysteresis, confirmation timing, false candidates, acquisition while pinched); replay-scenarios (noise without flicker); bench/replay (browser) | Five-minute live writing session: **not measured** |
| F10 Onset/dots/endpoints | unit/hand-reducer (onset, taps, release hold); unit/stroke (exact endpoints, punctuation, stationary pen); replay-scenarios (i-dot, decimal point, minus sign, release drift) | Real punctuation survival: **not measured** |
| F11 Stabilizer | unit/one-euro (reference vectors, irregular dt, duplicates, resets, presets); integration/signal-gates; docs/signal-report.md | Synthetic gates partly pass (ADR 0003); real traces and preset comprehension: **not measured** |
| F12 Discontinuity | unit/discontinuity (isolated, multi-landmark, fast sweeps, corners); replay-scenarios (landmark jump) | False-positive rate on real data: **not measured** |
| F13 Prediction | unit/prediction (bounds, first samples, stop/turn, stale, overshoot ≤ 3 px); integration/controller (identical board flag on/off) | Shipped **disabled**: perceived improvement not evaluated |
| F14 Two-hand arbitration | unit/hand-reducer (simultaneous, early/late join, release, expiry); replay-scenarios; bench/render (no phantom strokes) | **Not measured** with real hands |
| F15 Pan/zoom math | unit/view (anchor < 0.01 px, clamps, separation freeze, continuous rebase, no rotation); integration/transform-anchor (< 1 px through replay); bench/render (wheel anchor) | Visual anchor stability with real hands: **not measured** |
| F16 Infinite board/view | bench/render (pan beyond viewport and back, fit/reset empty and populated, resize at zoom) | Crispness after settling: checked by reference comparison, not by people |
| F17 Fist arming | unit/hand-reducer (arming, interruption, conflicts, disable); unit/features + features-real (rotation, partial curls, real fist photo); replay-scenarios (rotated fist, brief fist, non-fists) | Zero accidental erases in 5 min × 3 testers: **not measured** |
| F18 Eraser hit testing | unit/history-hit (crossings, width, curves, dots, grazing miss, sweep); integration/controller (radius at zoom, one action); bench/render (erase vs reference) | Radius agreement checked numerically, not by users |
| F19 Dropout/reacquisition | unit/hand-reducer (33/66/100/250 ms gaps, close/far return, release during gap, ambiguity, stale); replay-scenarios (short/long gap, pinched re-entry) | **Not measured** with real tracking loss |
| F20 Color/size | integration/controller (creation-scale width, existing strokes unchanged); e2e/editing (pixels: color and width apply to new strokes); bench/hand-ui (color by hand); unit/ui-logic (contrast) | — |
| F21 Hand-operated controls | unit/hand-reducer (one activation per pinch, hover never activates, drawing into strip); replay-scenarios (control press); bench/hand-ui (color, clear, pause/resume, late-enabled Undo) | Reachability with real hands: **not measured** |
| F22 Undo/redo | unit/history-hit (exact restore, order, redo invalidation, caps); integration/controller; e2e/editing (buttons, shortcuts, disabled states) | — |
| F23 Clear | e2e/editing (keyboard confirm/cancel, safe focus); bench/hand-ui (held pinch cannot confirm; second pinch confirms) | — |
| F24 Pointer/keyboard | bench/pointer (capture outside board, pointercancel, second pointer, middle button, move tool); bench/render (Space-drag, anchored wheel); e2e/editing (focus restrictions) | Full workflow without camera: automated only |
| F25 Pause/lifecycle | unit/hand-reducer (pause while drawing, resume needs release); unit/ui-logic (hidden timer); e2e/editing (button, P); bench/hand-ui (blur, long-hidden tab, pagehide, unplug, pause/resume by hand) | Real tab switching and device unplug: **not measured** |
| F26 Tutorial | unit/practice-export (event conditions, pan vs zoom); bench/practice-settings (full flow, separate board, real board unchanged, offer once) | 4 of 5 new users within 30 s: **not measured** |
| F27 Settings | unit/config (bounds, hysteresis, patch); unit/replay-format (migration); e2e/interface (labelled controls, reset); bench/practice-settings (applied at idle boundary) | Understandability without explanation: **not measured** |
| F28 Preview/accessibility | e2e/interface (names, pressed states, focus, keyboard traversal); bench/practice-settings (preview hidden, inference continues); unit/mapping (letterboxing) | Screen reader walkthrough: **not measured** |
| F29 Rendering/cache | bench/render (reference equality after every edit type, DPR 2, resize, flat frame cost, chunked rebuild without blank frames); benchmarks/render-workload | Visual quality on real displays: **not measured** |
| F30 PNG export | unit/practice-export (size, background, failure, active stroke); e2e/interface (download decoded and compared, empty board, encoder failure, URL revoked) | — |
| F31 Privacy/packaging | e2e/production (no dev tooling or source maps, GET-only same-origin, no websockets, no storage/cookies/caches/service workers); e2e/startup (same-origin requests, headers); bench/release (offline tracking) | Camera indicator on real hardware: **not measured** |
| F32 Recording/replay | unit/replay-format (schema, versions, limits, corruption); integration/replay-scenarios (determinism); bench/replay (speed invariance); bench/recording (indicator, limit, discard, export, replay) | Reproducing a real reported bug from a trace: **not exercised** (no real traces) |
| F33 HUD/metrics | unit/metrics (percentiles on known durations, ring buffer); bench/release (≤ 4 Hz, labels, hide, counter consistency); benchmarks/pipeline (independent display-frame and long-task probes) | Profiler cross-check: **not measured**; one unexplained 67 ms long task in 180 s (docs/performance.md) |
| F34 Resource/board limits | unit/history-hit (caps); integration/controller (guards keep work, huge stroke); integration/frame-scheduler (closed bitmaps); bench/release (cycles, heap); benchmarks/soak | Soak on designated hardware: see docs/performance.md (dev machine only) |
| F35 Compatibility/deployment | e2e/* run on the production build under a subpath with CSP and Permissions-Policy; e2e/production (generated `_headers`); integration/tracker-client (backend fallback); e2e/startup (missing media APIs) | Named Chrome/Edge targets: **only Chromium 159 on macOS 27.2 tested**; Edge, Windows, other browsers not tested |
| F36 Complete demo | bench/release (automated demo: write, recolor by hand, two-hand zoom, fist erase, undo by hand, export) | Five consecutive 90-second live demos: **not measured** |
