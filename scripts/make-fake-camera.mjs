#!/usr/bin/env node
// Builds tests/.cache/fake-camera.mjpeg from the MediaPipe test photos.
// Chromium plays it as a webcam via --use-file-for-fake-video-capture.
// Timeline (loops): 0–4 s one hand sweeping sideways, 4–8 s two hands.
// Requires ffmpeg on PATH. Synthetic source: not a real-camera test.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const images = join(root, 'tests', 'fixtures', 'images');
const out = join(root, 'tests', '.cache', 'fake-camera.mjpeg');

export function ensureFakeCamera() {
  if (existsSync(out) && statSync(out).size > 0) return out;
  mkdirSync(dirname(out), { recursive: true });
  const filter = [
    '[1:v]scale=-1:300[one]',
    '[2:v]scale=640:-1[two]',
    "[0:v][one]overlay=x='170+110*sin(2*PI*t/4)':y=90:enable='lt(t,4)'[v1]",
    "[v1][two]overlay=x=0:y='70+20*sin(2*PI*t/2)':enable='gte(t,4)',format=yuvj420p",
  ].join(';');
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=640x480:r=30:d=8',
      '-loop', '1', '-i', join(images, 'pointing_up.jpg'),
      '-loop', '1', '-i', join(images, 'right_hands.jpg'),
      '-filter_complex', filter,
      '-t', '8', '-r', '30', '-q:v', '3', '-f', 'mjpeg', out,
    ],
    { stdio: 'inherit' },
  );
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(ensureFakeCamera());
}
