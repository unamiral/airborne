# Smoother air writing and ink recognition

Research and initial macOS probe, November 2026.

## What the existing measurements say

The existing M2 benchmark reports 34.0 ms p95 worker inference, 50.3 ms
p95 observed-frame-to-draw-submission latency, and 0.1 ms p95 drawing on a
101,200-point board. The inference and submission targets are 15 ms and
40 ms. The benchmark used a 30 fps fake camera with hovering hands. It
doesn't measure physical motion-to-ink latency or how well the app captures
pinch transitions, quick corners, and small letters. Keep the incremental
canvas renderer and latest-frame scheduler. Spend the first engineering pass
on inference, sampling consistency and stroke starts. [Repo performance report](performance.md)

The One Euro filter already reduces synthetic stationary jitter by 55% at
the default preset, with 15 ms median lag under the documented conditions.
The held-out short zigzag and 15 Hz corners were visibly displaced in the
synthetic suite. Those are better tuning targets than another blanket
reduction in filter cutoff. [Repo smoothing results](decisions/0003-smoothing-presets.md)
[One Euro filter research](https://gery.casiez.net/1euro/)

## Tracking shortlist

| Candidate | Where to prototype | What decides whether it ships |
| --- | --- | --- |
| Apple Vision hand pose | Native macOS probe driven by AVFoundation pixel buffers | Real writing latency, visible fingertip jitter, pinch accuracy and the feasibility of distributing a native component |
| RTMPose Hand5 with a hand detector | Browser worker with ONNX Runtime Web WASM, then hardware acceleration where supported | Combined detector and keypoint p95, crop reacquisition, model payload, fingertip jitter and gesture accuracy |
| TensorFlow.js MediaPipeHands Lite | Browser worker as a lighter comparison | Useful speed control against the existing Tasks model. It remains in the MediaPipe model family |
| Current MediaPipe Tasks GPU and WASM CPU | Baseline and browser fallback | Compare against the same live and recorded sequences, including browser startup and reduced-performance devices |

Apple documents confidence-scored 2D joints and a pinch-to-draw example.
MMPose's published hand pipeline pairs RTMPose with a detector. ONNX Runtime
Web documents its execution-provider matrix. TensorFlow.js exposes a Lite
variant and video tracking so the detector can be skipped while the
previous crop is reliable. [Apple drawing sample](https://developer.apple.com/documentation/vision/detecting_hand_poses_with_vision)
[MMPose hand pipeline](https://github.com/open-mmlab/mmpose/blob/main/docs/en/user_guides/inference.md)
[ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
[TensorFlow.js MediaPipeHands](https://github.com/tensorflow/tfjs-models/blob/master/hand-pose-detection/src/tfjs/README.md)

### Apple Vision smoke test

On Apple M2 with macOS 27.2, a Swift probe reused a
`VNDetectHumanHandPoseRequest` with a maximum of two hands, creating a
`VNImageRequestHandler(url:)` for each run. It timed `handler.perform`
for 12 repetitions per repository JPG. Warm medians and maxima use the
final 10 repetitions of each fixture.

| Fixture | Detected hands | Warm median | Warm max |
| --- | ---: | ---: | ---: |
| fist | 1 | 7.6 ms | 8.1 ms |
| pointing up | 1 | 8.1 ms | 9.2 ms |
| right hands | 2 | 11.0 ms | 12.3 ms |
| thumb up | 1 | 9.2 ms | 9.6 ms |
| victory | 1 | 9.0 ms | 9.6 ms |

The first call took 5.77 s in this run. The probe had no live capture,
browser transport, drawing or ground-truth landmark scoring. These timing
ranges justify a native live-camera prototype. The existing MediaPipe video
benchmark uses a different workload, so the numbers don't establish a
speedup or an accuracy ranking.

The current reducer relies on metric 3D landmarks for fist detection and
some pinch and writing-pose checks. A different backend needs explicit
capabilities and a calibrated 2D gesture extractor when world landmarks
are absent. Preserve the actual coordinate space, joint confidence, image
orientation and handedness when available. Test projected false pinches
with the hand edge-on and look for false erases before wiring destructive
gestures to the new backend. [Apple Vision hand pose API](https://developer.apple.com/documentation/vision/vndetecthumanhandposerequest)

## Live ink experiments

1. Record short writing clips and replay the same timestamps through every
   model. Include slow hovers, fast diagonal strokes, hard turns, dots,
   quick pen lifts, wrists moving across the camera, hands crossing, and
   partial occlusion. Add distinct clips for left-handed writers, lighting
   and distance variation. Track actual accepted sample intervals and
   result age as well as inference time.
2. Verify the delivered webcam rate. The app already requests 60 fps, and
   the baseline source delivered 30 fps. Try 60 fps when both capture and
   tracking can sustain it with fresh results. Keep newest-frame admission.
   Compare one-hand writing mode against two-hand mode with identical
   video and keep two-hand gestures available where they perform well.
3. Use per-joint confidence and dropout duration to distinguish unstable
   estimates from fast deliberate movement. During brief loss, freeze the
   preview and resume only across a plausible displacement. Keep the
   existing outlier and identity handling as a baseline. Tune pinch
   hysteresis and provisional samples on dots and short strokes to measure
   lost starts and stray tails.
4. Compare the existing One Euro filter with an adaptive or confidence-weighted
   filter on the same recordings. Tune on stationary jitter, corner error,
   and lag together. Try the existing visual-only prediction on straight,
   stable runs and measure overshoot at stops before enabling it by
   default. Keep measured or filtered observations as the source of saved
   ink and recognition. [Apple drawing input sample](https://developer.apple.com/documentation/UIKit/leveraging-touch-input-for-drawing-apps)
5. For optional polish, fit curves to corner-delimited spans after pen-up.
   Evaluate the fit against a screen-space deviation budget and preserve
   dots, cusps, endpoints and stroke boundaries. Preview any larger
   baseline or spacing changes on explicitly selected text. Preserve
   superscripts, subscripts and diagram edges in mixed work.

The included cleanup change weights neighbouring samples by distance.
Equal weights pull a sample along a perfectly straight line when the
neighbouring samples are unevenly spaced. The regression test covers that
case. Live filtering and prediction are separate experiments.

## Turning strokes into editable content

The existing Text command sends all board strokes to the optional native
browser API and takes the top English text prediction. The Clean command
smooths and can align roughly uniform clusters, with a single undoable
edit. Start with selection or recent strokes, preserve stroke order and
boundaries, and add optional capture timestamps to future strokes. Keep
imports of old boards working with coordinates alone. InkML provides a
reference for representing timestamped traces. [Current browser API](https://developer.chrome.com/docs/web-platform/handwriting-recognition)
[InkML](https://www.w3.org/TR/InkML/)

| Mode | First prototype | Review and output |
| --- | --- | --- |
| Text | Rank Latin letters, words, numbers and punctuation. Evaluate MyScript on real camera traces. For a narrow offline experiment, try a multistroke classifier for isolated printed symbols | Editable text with alternatives for ambiguities such as O/0 and I/l/1 |
| Math | Evaluate MyScript and Mathpix on the same equations, including spatial structure and Greek letters | Typeset formula and editable LaTeX, with candidate corrections for exponents and fraction grouping |
| Diagram | Fit lines, rectangles, ellipses and arrows locally, then infer connections from nearby endpoints. Compare flowchart quality against MyScript | Editable shapes and connectors. Freehand strokes remain available during review |
| Science | Evaluate formula, unit and Greek-symbol examples in Math. Give molecular structures their own mode and benchmark | Preserve chemical subscripts, superscripts and charges. Validate molecular structure separately with labelled examples |

MyScript's web REST integration covers text, math, raw content and diagrams.
Mathpix documents direct stroke submission for math and STEM content,
including chemistry diagrams, with different outputs for content that
doesn't fit a single LaTeX expression. The University of Washington's $Q
template recognizer is a practical offline baseline for constrained
symbols, with a separate language or layout model needed for words or
structured math. Apply domain constraints when ranking ambiguous
candidates. [MyScript web SDK](https://developer.myscript.com/docs/cloud/4.5/)
[Mathpix stroke API](https://docs.mathpix.com/reference/post-v3-strokes)
[$Q recognizer](https://depts.washington.edu/madlab/proj/dollar/qdollar.html)

Show candidate output on or alongside the selected ink. Let users accept
an editable result with one undoable action. Run conversion after pen-up
or on demand so it doesn't compete with capture. The current application
processes ink on-device. A cloud experiment needs separate opt-in, a
server-side credential, and a clear disclosure that it sends selected
strokes. Use local fitting for basic shapes and keep input available when a
recognizer or network is unavailable.

## Acceptance on actual computers

Use the existing thresholds of p95 inference at most 15 ms, observed-frame
to draw submission at most 40 ms, physical motion-to-ink at most 120 ms
and physical pinch-to-ink at most 150 ms. Measure physical latency with
external high-frame-rate video. Include cold launch, sustained use on
battery and during screen sharing, and permission, GPU and camera-loss
recovery. Compare Apple Silicon and Intel MacBooks in Safari and Chromium,
plus Windows and lower-powered machines before making compatibility claims.
Pointer mode provides an input path when a webcam is absent or blocked.

For recognition, report held-out top-1 and top-3 symbol accuracy, word
error rate, equivalent formula rate, diagram shape and connector accuracy,
and corrections per accepted conversion. Include blank selections, mixed
ink, out-of-vocabulary symbols, and wrong high-confidence answers. Use
actual air-written traces when deciding release quality and record results
by camera rate and device. Website support and a native Mac performance
path can be judged independently.
