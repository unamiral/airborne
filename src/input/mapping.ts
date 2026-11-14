/**
 * Camera to interaction-surface mapping. The full camera frame maps to the
 * full surface, mirrored exactly once. Axes scale independently when aspect
 * ratios differ. Sensitivity changes response without cropping the frame.
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
  /** Geometric mean surface CSS px per camera pixel, for palm-size heuristics. */
  readonly scale: number;

  constructor(readonly input: MappingInput) {
    const { cameraWidth: cw, cameraHeight: ch, surfaceWidth: sw, surfaceHeight: sh, reach } = input;
    if (!(cw > 0 && ch > 0 && sw > 0 && sh > 0 && reach > 0 && reach <= 1)) {
      throw new RangeError('SurfaceMapping: dimensions and reach must be positive');
    }
    this.rect = { u0: 0, u1: 1, v0: 0, v1: 1 };
    this.scale = Math.sqrt((sw / cw) * (sh / ch));
  }

  /** Maps unmirrored normalized camera coordinates to the surface. */
  toSurface(u: number, v: number): MappedPoint {
    // Fix the centre and both edges; larger reach gives finer centre control.
    const exponent = this.input.reach / 0.7;
    const curve = (value: number): number => {
      const d = 2 * value - 1;
      return (1 + Math.sign(d) * Math.pow(Math.abs(d), exponent)) / 2;
    };
    const x = (1 - curve(u)) * this.input.surfaceWidth;
    const y = curve(v) * this.input.surfaceHeight;
    const inReach = u >= 0 && u <= 1 && v >= 0 && v <= 1;
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
