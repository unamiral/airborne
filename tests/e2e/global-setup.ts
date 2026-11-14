import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Builds the fake-camera video once; both builds must already exist. */
export default function globalSetup(): void {
  execFileSync('node', ['scripts/make-fake-camera.mjs'], { stdio: 'inherit' });
  for (const dir of ['dist/index.html', 'dist-bench/index.html']) {
    if (!existsSync(dir)) {
      throw new Error(`${dir} is missing. Run "npm run build && npm run build:bench" before browser tests.`);
    }
  }
}
