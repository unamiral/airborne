# 0003 — Pen stabilizer: filter structure and preset values

Status: accepted for this release (M1, 2026-11-14). Synthetic evidence only;
real-camera traces and user trials are still required (plan §14).

## Structure

- One stage of smoothing on the pen point only: a timestamp-aware One Euro
  filter per track, per axis, in surface CSS pixels with dt in seconds
  (`src/signal/one-euro.ts`). It matches the authors' reference implementation
  to 1e-9 on jittered timestamps (`tests/unit/one-euro.test.ts`), except that
  duplicate/reversed timestamps are rejected and a gap over 250 ms restarts it.
- Gesture features (pinch ratio, fist) come from unfiltered landmarks, so
  smoothing never delays pen-up or shifts thresholds.
- No moving average, spring, spline fitting, Kalman, or median filter in
  series. Geometry adds midpoint quadratics, which stay inside the control
  triangle (no overshoot) and keep corners exact.
- The filter stays warm during hover; samples are only fed when a new result
  arrives (never repeated per render frame). Histories reset on identity
  changes, track expiry, source changes, and reach/viewport remapping.

## Preset values

The plan's seeds (min cutoff 2.5/1.5/0.8 Hz, β 0.03/0.02/0.015, derivative
cutoff 1 Hz) were evaluated first (`docs/signal-report.md`, "Plan seeds").
With a 1 Hz derivative cutoff the speed estimate reacts slowly, so the
adaptive cutoff stays low on curves: Balanced lagged 29–37 ms on slow traces
and reached 4.9 px p95 shape error at σ = 1 px.

A sweep over min cutoff {1, 1.5, 2, 2.5} Hz × β {0.01…0.08} × derivative
cutoff {1, 2} Hz (30 Hz, σ = 1 and 2 px) selected:

| Preset | Min cutoff | β (1/px) | Derivative cutoff | Stationary RMS reduction (σ=2 px) | Median lag (σ=1 px) |
|---|---:|---:|---:|---:|---:|
| Light | 3.0 Hz | 0.04 | 2 Hz | 49% | 12 ms |
| Balanced (default) | 2.0 Hz | 0.03 | 2 Hz | 55% | 15 ms |
| Steady | 1.0 Hz | 0.02 | 2 Hz | 63% | 22 ms |

Held-out traces (different seeds, paths not used for tuning) improved with
the tuned Balanced on lag (9–22 ms vs 13–35 ms) and p95 shape (1.9–3.4 px vs
2.0–5.9 px) at 30 Hz, σ = 1 px.

## Gate results (Balanced, synthetic, 30 Hz)

Pass: stationary noise ≥ 50% (55%), median lag ≤ 25 ms (15 ms), p95 shape ≤ 3 px
on standard paths at σ = 1 px (max 2.87 px), standard corners ≤ 4 px (max 3.58 px).

Fail (reported, not hidden): p95 shape at σ = 2 px (max 4.58 px; raw is
4.5–5.1 px), sharp short-segment held-out vertices (zigzag 5.9 px), and all
corners at 15 Hz sampling (6–8 px). At σ = 1 px the filter does not improve
lag-compensated shape error on curves compared with raw input (2.2–2.6 px raw);
its benefit there is jitter reduction.

## Consequences

- Real camera noise levels are unknown until consented recordings exist; the
  presets must be re-checked against recorded traces (plan §14 "Recorded
  fixture suite"), split into tuning and held-out sets.
- Prediction (plan §8.6) remains disabled: it passes its 3 px overshoot gate
  on the synthetic suite only after lowering the distance clamp from 6 to 5 px,
  and perceived improvement has not been evaluated with users.
