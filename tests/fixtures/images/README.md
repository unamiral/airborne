# Hand test images

These photographs are MediaPipe test assets, downloaded from
`https://storage.googleapis.com/mediapipe-assets/<name>` (the files referenced by
`mediapipe/tasks/testdata/vision` in the MediaPipe repository). MediaPipe is
distributed under the Apache License 2.0; see
https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE.

They are used only by tests:

- `scripts/make-fake-camera.mjs` composes them into a looping MJPEG that
  Chromium plays as a fake webcam, so the real model runs in the real worker.
- Real-model landmark fixtures (`tests/fixtures/real/`) are extracted from them.

This is a synthetic video source, not a real-camera test.
