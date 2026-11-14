/** Loads and validates replay fixtures from tests/fixtures. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseReplay, type ReplayRecord } from '../../src/dev/replay-format';

export const FIXTURE_ROOT = join(process.cwd(), 'tests', 'fixtures');

export function loadFixture(relativePath: string): ReplayRecord {
  const json: unknown = JSON.parse(readFileSync(join(FIXTURE_ROOT, relativePath), 'utf8'));
  const parsed = parseReplay(json);
  if (!parsed.ok) throw new Error(`${relativePath}: ${parsed.errors.join('; ')}`);
  return parsed.record;
}

export function listFixtures(subdir: string): string[] {
  return readdirSync(join(FIXTURE_ROOT, subdir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(subdir, f));
}
