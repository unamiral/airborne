import { expect, test } from '@playwright/test';
import { enterBoard } from '../support';
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_VERSION, DEFAULT_CONFIG } from '../../../src/app/config';
import { MEDIAPIPE_VERSION, MODEL_SHA256 } from '../../../src/app/assets';
import type {} from '../../../src/dev/devtools';
import { REPLAY_SCHEMA_VERSION } from '../../../src/dev/replay-format';

// Runs the real model (CPU delegate, production worker code) on the MediaPipe
// test photos and checks the hand counts. With UPDATE_FIXTURES=1 it also
// writes tests/fixtures/real/model-on-images.json, which unit tests use to
// validate gesture features on real detector output.

const IMAGES = [
  { file: 'pointing_up.jpg', hands: 1 },
  { file: 'right_hands.jpg', hands: 2 },
  { file: 'fist.jpg', hands: 1 },
  { file: 'victory.jpg', hands: 1 },
  { file: 'thumb_up.jpg', hands: 1 },
];

test('real model landmarks on still images', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./?hud=0');
  await enterBoard(page);
  const payload = IMAGES.map((i) => readFileSync(`tests/fixtures/images/${i.file}`).toString('base64'));
  const results = await page.evaluate(async (b64s) => {
    const blobs = b64s.map((b) => new Blob([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }));
    const sizes = await Promise.all(blobs.map(async (b) => {
      const bmp = await createImageBitmap(b);
      const s = { width: bmp.width, height: bmp.height };
      bmp.close();
      return s;
    }));
    const hands = await window.__air!.detectImages(blobs, 'CPU');
    return { hands, sizes };
  }, payload);
  results.hands.forEach((hands, i) => expect(hands.length, IMAGES[i]!.file).toBe(IMAGES[i]!.hands));

  if (process.env.UPDATE_FIXTURES === '1') {
    const record = {
      schema: REPLAY_SCHEMA_VERSION,
      source: 'model-on-image',
      createdAt: new Date().toISOString(),
      scenario: {
        name: 'model-on-images',
        description: `Real ${MEDIAPIPE_VERSION} model (CPU) on MediaPipe test photos; one frame per image, ${IMAGES.map((i) => i.file).join(', ')}`,
        tags: IMAGES.map((i) => i.file),
      },
      camera: results.sizes[0],
      surface: { width: 1280, height: 720, stripWidth: 120 },
      configVersion: CONFIG_VERSION,
      config: DEFAULT_CONFIG,
      backend: { delegate: 'CPU', mediapipeVersion: MEDIAPIPE_VERSION, modelSha256: MODEL_SHA256 },
      frames: results.hands.map((hands, i) => ({
        t: i * 1000,
        ageMs: 0,
        hands: hands.map((h) => ({
          ...h,
          landmarks: h.landmarks.map((v) => Math.round(v * 1e6) / 1e6),
          world: h.world.map((v) => Math.round(v * 1e7) / 1e7),
        })),
      })),
      expected: {},
      imageSizes: results.sizes,
    };
    writeFileSync('tests/fixtures/real/model-on-images.json', `${JSON.stringify(record)}\n`);
  }
});
