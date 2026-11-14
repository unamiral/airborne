/**
 * Camera → interaction-surface mapping (plan §7).
 *
 * - Mirroring happens exactly once, here: uMirror = 1 - u.
 * - The reach rectangle is centred in the camera frame. Deviation from the
 *   plan's literal "central 70% of width and height": the rectangle keeps the
 *   surface's aspect ratio (measured in camera pixels) and is the largest
 *   such rectangle inside the central `reach` fraction of the frame. A
 *   per-axis stretch (e.g. 4:3 camera onto a 16:9 surface) would draw circles
 *   as ellipses 33% wider than tall; isotropic mapping keeps handwriting
 *   shapes intact. See docs/decisions/0004-coordinate-mapping.md.
 * - Distances measured on the image use actual camera pixels, because
 *   normalized x and y have different pixel scales on non-square frames.
 * - Out-of-reach positions are reported, never clamped into edge lines.
 */
import { surfacePoint, type SurfacePoint } from '../core/coords';

export interface MappingInput {
  readonly cameraWidth: number;
  readonly cameraHeight: number;
  readonly surfaceWidth: number;
  readonly surfaceHeight: number;
  /** Fraction of the camera frame, [0.5, 0.9]. */
  readonly reach: number;
}

/** Reach rectangle in normalized camera coordinates (symmetric, so mirror-invariant). */
export interface ReachRect {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

export interface MappedPoint {
  readonly point: SurfacePoint;
  readonly inReach: boolean;
}

export class SurfaceMapping {
  readonly rect: ReachRect;
  /** Surface CSS px per camera pixel (same on both axes). */
  readonly scale: number;

  constructor(readonly input: MappingInput) {
    const { cameraWidth: cw, cameraHeight: ch, surfaceWidth: sw, surfaceHeight: sh, reach } = input;
    if (!(cw > 0 && ch > 0 && sw > 0 && sh > 0 && reach > 0 && reach <= 1)) {
      throw new RangeError('SurfaceMapping: dimensions and reach must be positive');
    }
    // Largest rectangle with the surface's aspect ratio inside the central
    // reach*cw x reach*ch region, in camera pixels.
    let wPx = reach * cw;
    let hPx = (wPx * sh) / sw;
    if (hPx > reach * ch) {
      hPx = reach * ch;
      wPx = (hPx * sw) / sh;
    }
    const halfU = wPx / cw / 2;
    const halfV = hPx / ch / 2;
    this.rect = { u0: 0.5 - halfU, u1: 0.5 + halfU, v0: 0.5 - halfV, v1: 0.5 + halfV };
    this.scale = sw / wPx;
  }

  /** Maps unmirrored normalized camera coordinates to the surface. */
  toSurface(u: number, v: number): MappedPoint {
    const { u0, u1, v0, v1 } = this.rect;
    const mirrored = 1 - u;
    const x = ((mirrored - u0) / (u1 - u0)) * this.input.surfaceWidth;
    const y = ((v - v0) / (v1 - v0)) * this.input.surfaceHeight;
    const inReach = x >= 0 && y >= 0 && x <= this.input.surfaceWidth && y <= this.input.surfaceHeight;
    return { point: surfacePoint(x, y), inReach };
  }

  /** Converts a length measured in camera pixels to surface CSS px. */
  cameraLengthToSurface(cameraPx: number): number {
    return cameraPx * this.scale;
  }

  equals(other: MappingInput): boolean {
    const a = this.input;
    return (
      a.cameraWidth === other.cameraWidth &&
      a.cameraHeight === other.cameraHeight &&
      a.surfaceWidth === other.surfaceWidth &&
      a.surfaceHeight === other.surfaceHeight &&
      a.reach === other.reach
    );
  }
}

/** Distance between two normalized landmarks in actual camera pixels. */
export function cameraPixelDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cameraWidth: number,
  cameraHeight: number,
): number {
  return Math.hypot((ax - bx) * cameraWidth, (ay - by) * cameraHeight);
}
