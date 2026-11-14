/**
 * Camera permission and stream ownership (plan §4 "First visit and camera
 * setup", §11 lifecycle). Each failure class maps to its own explanation and
 * recovery action.
 */
import type { CameraConfig } from '../app/config';

export type CameraErrorKind =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-camera'
  | 'camera-busy'
  | 'disconnected'
  | 'unknown';

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

/** User-facing explanation and recovery action for each failure class. */
export const CAMERA_ERROR_TEXT: Readonly<Record<CameraErrorKind, { title: string; help: string }>> = {
  'insecure-context': {
    title: 'Camera needs a secure page',
    help: 'Browsers only allow cameras on https:// pages or localhost. Open the app over HTTPS, or keep drawing with the mouse.',
  },
  unsupported: {
    title: 'Camera not available in this browser',
    help: 'This browser does not provide camera access to web pages. Use Chrome or Edge on a laptop, or keep drawing with the mouse.',
  },
  'permission-denied': {
    title: 'Camera permission was denied',
    help: 'Allow camera access from the camera icon in the address bar (or site settings), then press Try again. Mouse drawing works without a camera.',
  },
  'no-camera': {
    title: 'No camera found',
    help: 'Connect a camera or choose another one in Settings, then press Try again.',
  },
  'camera-busy': {
    title: 'Camera is in use',
    help: 'Another app or tab may be using the camera. Close it, then press Try again.',
  },
  disconnected: {
    title: 'Camera disconnected',
    help: 'The camera stopped sending video. Reconnect it and press Try again. Your board is unchanged.',
  },
  unknown: {
    title: 'Camera could not start',
    help: 'Press Try again, or keep drawing with the mouse.',
  },
};

export interface MediaEnvironment {
  readonly isSecureContext: boolean;
  readonly mediaDevices: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> | undefined;
}

export function browserMediaEnvironment(): MediaEnvironment {
  return {
    isSecureContext: globalThis.isSecureContext,
    // mediaDevices is undefined on insecure origins in Chromium.
    mediaDevices: typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
  };
}

/** Capability check that never triggers a permission prompt. */
export function cameraSupportProblem(env: MediaEnvironment): CameraErrorKind | null {
  if (!env.isSecureContext) return 'insecure-context';
  if (env.mediaDevices === undefined || typeof env.mediaDevices.getUserMedia !== 'function') {
    return 'unsupported';
  }
  return null;
}

/** Maps getUserMedia DOMException names to failure classes. */
export function classifyCameraError(error: unknown): CameraErrorKind {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'camera-busy';
    case 'TypeError':
      return 'unsupported';
    default:
      return 'unknown';
  }
}

/** Ideal (not mandatory) constraints; the actual settings are reported. */
export function cameraConstraints(config: CameraConfig, deviceId: string | null): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: config.idealWidth },
    height: { ideal: config.idealHeight },
    frameRate: { ideal: config.idealFrameRate },
  };
  if (deviceId !== null) video.deviceId = { exact: deviceId };
  return { video, audio: false };
}

export async function openCamera(
  env: MediaEnvironment,
  config: CameraConfig,
  deviceId: string | null,
): Promise<MediaStream> {
  const problem = cameraSupportProblem(env);
  if (problem !== null) throw new CameraError(problem, CAMERA_ERROR_TEXT[problem].title);
  try {
    // cameraSupportProblem guarantees mediaDevices is present.
    return await env.mediaDevices!.getUserMedia(cameraConstraints(config, deviceId));
  } catch (error) {
    const kind = classifyCameraError(error);
    throw new CameraError(kind, CAMERA_ERROR_TEXT[kind].title);
  }
}

export interface CameraDevice {
  readonly deviceId: string;
  readonly label: string;
}

/** Device labels are only exposed after permission has been granted. */
export async function listCameras(env: MediaEnvironment): Promise<CameraDevice[]> {
  if (env.mediaDevices === undefined) return [];
  const devices = await env.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput' && d.deviceId !== '')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label !== '' ? d.label : `Camera ${i + 1}` }));
}

export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export interface ActualCameraSettings {
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly deviceId: string | null;
  readonly label: string;
}

export function actualSettings(stream: MediaStream): ActualCameraSettings {
  const track = stream.getVideoTracks()[0];
  const s = track?.getSettings() ?? {};
  return {
    width: s.width ?? null,
    height: s.height ?? null,
    frameRate: s.frameRate ?? null,
    deviceId: s.deviceId ?? null,
    label: track?.label ?? '',
  };
}
