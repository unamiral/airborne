import { describe, expect, it, vi } from 'vitest';
import {
  CAMERA_ERROR_TEXT,
  CameraError,
  cameraConstraints,
  cameraSupportProblem,
  classifyCameraError,
  listCameras,
  openCamera,
  type MediaEnvironment,
} from '../../src/camera/camera-source';
import { DEFAULT_CONFIG } from '../../src/app/config';

const domError = (name: string) => Object.assign(new Error(name), { name });

function env(getUserMedia: () => Promise<MediaStream>, secure = true): MediaEnvironment {
  return {
    isSecureContext: secure,
    mediaDevices: { getUserMedia, enumerateDevices: () => Promise.resolve([]) },
  };
}

describe('camera errors', () => {
  it('classifies each getUserMedia failure separately', () => {
    expect(classifyCameraError(domError('NotAllowedError'))).toBe('permission-denied');
    expect(classifyCameraError(domError('SecurityError'))).toBe('permission-denied');
    expect(classifyCameraError(domError('NotFoundError'))).toBe('no-camera');
    expect(classifyCameraError(domError('OverconstrainedError'))).toBe('no-camera');
    expect(classifyCameraError(domError('NotReadableError'))).toBe('camera-busy');
    expect(classifyCameraError(domError('AbortError'))).toBe('camera-busy');
    expect(classifyCameraError(domError('Weird'))).toBe('unknown');
    expect(classifyCameraError('string')).toBe('unknown');
  });

  it('has distinct actionable text for every class', () => {
    const titles = new Set(Object.values(CAMERA_ERROR_TEXT).map((t) => t.title));
    expect(titles.size).toBe(Object.keys(CAMERA_ERROR_TEXT).length);
    for (const text of Object.values(CAMERA_ERROR_TEXT)) expect(text.help.length).toBeGreaterThan(20);
  });

  it('detects insecure contexts and missing APIs without prompting', () => {
    const gum = vi.fn();
    expect(cameraSupportProblem(env(gum, false))).toBe('insecure-context');
    expect(cameraSupportProblem({ isSecureContext: true, mediaDevices: undefined })).toBe('unsupported');
    expect(gum).not.toHaveBeenCalled();
  });

  it('wraps failures in CameraError with the classified kind', async () => {
    await expect(openCamera(env(() => Promise.reject(domError('NotAllowedError'))), DEFAULT_CONFIG.camera, null)).rejects.toMatchObject({
      kind: 'permission-denied',
    });
    await expect(openCamera(env(() => Promise.resolve({} as MediaStream), false), DEFAULT_CONFIG.camera, null)).rejects.toBeInstanceOf(CameraError);
  });
});

describe('camera constraints', () => {
  it('requests video only with ideal (not mandatory) 640x480@60', () => {
    const c = cameraConstraints(DEFAULT_CONFIG.camera, null);
    expect(c.audio).toBe(false);
    expect(c.video).toEqual({ width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } });
  });

  it('uses an exact deviceId only for explicit selection', () => {
    const c = cameraConstraints(DEFAULT_CONFIG.camera, 'abc');
    expect((c.video as MediaTrackConstraints).deviceId).toEqual({ exact: 'abc' });
  });

  it('lists only labeled-or-numbered video inputs', async () => {
    const e: MediaEnvironment = {
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: vi.fn(),
        enumerateDevices: () =>
          Promise.resolve([
            { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
            { kind: 'videoinput', deviceId: 'cam1', label: '' },
            { kind: 'videoinput', deviceId: 'cam2', label: 'USB Camera' },
            { kind: 'videoinput', deviceId: '', label: '' },
          ] as MediaDeviceInfo[]),
      },
    };
    expect(await listCameras(e)).toEqual([
      { deviceId: 'cam1', label: 'Camera 1' },
      { deviceId: 'cam2', label: 'USB Camera' },
    ]);
  });
});
