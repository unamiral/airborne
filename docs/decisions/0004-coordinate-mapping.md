# 0004 — Coordinate mapping and hand identity

Status: superseded for mapping. The full camera frame now maps to the full interaction surface; sensitivity applies a centered power curve while preserving frame edges. Axes scale independently when aspect ratios differ, so shapes can stretch. The original decision is retained below for historical context.

## Spaces

`src/core/coords.ts` brands five spaces so the type checker rejects mix-ups:
normalized camera (unmirrored), interaction surface CSS px (control strip +
board), board-local CSS px, world, and canvas backing-store pixels (renderer
only). Device pixel ratio never enters gesture thresholds.

## Mapping (`src/input/mapping.ts`)

- Mirroring happens once, at the input mapping: `uMirror = 1 - u`.
- **Deviation from the plan's literal wording.** The plan maps the central
  70% of camera width *and* height onto the surface. With a 4:3 camera and a
  16:9 surface that stretches x by 33% relative to y, so a circle drawn in the
  air becomes an ellipse on the board. Handwriting fidelity ranks above
  literal geometry in the plan's priorities, so the reach rectangle is the
  largest rectangle **with the surface's aspect ratio (in camera pixels)**
  inside the central `reach` fraction of the frame. Reach still controls how
  much physical motion covers the workspace (default 0.7, range 0.5–0.9). With
  640×480 and a 1280×720 surface the rectangle is 448×252 camera px.
- Out-of-reach positions are reported (`inReach: false`) and stop ink; they are
  never clamped into lines along the edge. Re-entering while pinched does not
  restart ink until release.
- Landmark distances use actual camera pixels (`cameraPixelDistance`).
- The hand is mapped onto the whole interaction surface; control hit regions
  (`[data-hand-target]`) are resolved before board coordinates.
- Any mapping change (resize, reach, camera size) resets filter histories, and
  a remap during an interaction interrupts it and requires release.

## Identity (`src/tracking/identity.ts`)

- At most two detections are associated with at most two tracks by scoring
  every assignment: palm distance in palm sizes after a bounded velocity
  prediction, palm-size consistency, and a small penalty for confident
  handedness disagreement. Handedness is never an identity.
- If another plausible assignment moves a detection to a different track (or a
  track to a different detection) within 0.35 palm sizes of the best, the frame
  is ambiguous for those tracks: the reducer ends or freezes their interaction,
  disarms them, and requires a fresh open-hand observation.
- Tracks expire after 250 ms absent; expiry ends ownership but is not a release.
  Returning or new tracks must be seen open before they can act.
- Identity and per-track filters use camera pixels, so they do not depend on
  the reach mapping.
