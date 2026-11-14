/**
 * One Euro filter (Casiez, Roussel, Vogel, "1€ Filter: A Simple Speed-based
 * Low-pass Filter for Noisy Input in Interactive Systems", CHI 2012).
 *
 * Adapted from the authors' TypeScript reference implementation,
 * https://github.com/casiez/OneEuroFilter (typescript/src/OneEuroFilter.ts):
 *
 *   Copyright 2019 Inria. BSD License (BSD-3-Clause).
 *   Redistribution and use in source and binary forms, with or without
 *   modification, are permitted provided that the following conditions are
 *   met: 1. Redistributions of source code must retain the above copyright
 *   notice, this list of conditions and the following disclaimer.
 *   2. Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 *   3. Neither the name of the copyright holder nor the names of its
 *   contributors may be used to endorse or promote products derived from this
 *   software without specific prior written permission.
 *   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 *   AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED.
 *
 * Equations (plan §8.3), with dt in seconds and x in CSS pixels:
 *   alpha(f, dt) = 1 / (1 + 1 / (2*pi*f*dt))
 *   d            = (x - previousFilteredX) / dt
 *   filteredD    = lowPass(d, alpha(derivativeCutoff, dt))
 *   cutoff       = minCutoff + beta * |filteredD|
 *   filteredX    = lowPass(x, alpha(cutoff, dt))
 *
 * Deliberate differences from the reference (tested in one-euro.test.ts):
 * - Duplicate or reversed timestamps are rejected (no update, returns null)
 *   instead of reusing the previous frequency; repeated samples carry no new
 *   evidence and must not change the filter response.
 * - A gap longer than `maxGapS` re-initializes the filter at the new sample.
 * With strictly increasing timestamps and no long gaps, outputs match the
 * reference exactly.
 */
import type { OneEuroParams } from '../app/config';

export function smoothingAlpha(cutoffHz: number, dtS: number): number {
  return 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dtS));
}

export class OneEuroFilter {
  private x = 0;
  private dx = 0;
  private lastT = 0;
  private initialized = false;

  constructor(
    private params: OneEuroParams,
    /** Gap after which the filter restarts at the new sample, seconds. */
    private readonly maxGapS = 0.25,
  ) {}

  setParams(params: OneEuroParams): void {
    this.params = params;
  }

  get value(): number | null {
    return this.initialized ? this.x : null;
  }

  reset(): void {
    this.initialized = false;
    this.dx = 0;
  }

  /** Filters `value` observed at `tS` seconds; null if the timestamp is not new. */
  filter(value: number, tS: number): number | null {
    if (!this.initialized) return this.init(value, tS);
    const dt = tS - this.lastT;
    if (!(dt > 0)) return null;
    if (dt > this.maxGapS) return this.init(value, tS);
    const { minCutoffHz, beta, derivativeCutoffHz } = this.params;
    const derivative = (value - this.x) / dt;
    const ad = smoothingAlpha(derivativeCutoffHz, dt);
    this.dx = ad * derivative + (1 - ad) * this.dx;
    const cutoff = minCutoffHz + beta * Math.abs(this.dx);
    const a = smoothingAlpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    this.lastT = tS;
    return this.x;
  }

  private init(value: number, tS: number): number {
    this.x = value;
    this.dx = 0;
    this.lastT = tS;
    this.initialized = true;
    return value;
  }
}

/** Independent per-axis filtering of a 2D point (matches the reference). */
export class PointFilter {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(params: OneEuroParams, maxGapS = 0.25) {
    this.fx = new OneEuroFilter(params, maxGapS);
    this.fy = new OneEuroFilter(params, maxGapS);
  }

  setParams(params: OneEuroParams): void {
    this.fx.setParams(params);
    this.fy.setParams(params);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  /** Returns the filtered point, or null for a duplicate/reversed timestamp. */
  filter(x: number, y: number, tS: number): { x: number; y: number } | null {
    const fx = this.fx.filter(x, tS);
    const fy = this.fy.filter(y, tS);
    if (fx === null || fy === null) return null;
    return { x: fx, y: fy };
  }
}
