/**
 * R3 sprint 1 — CLI fixture path helpers.
 *
 * Reuses the `tests/fixtures/stacks/` set introduced by R1 so the CLI
 * tests don't duplicate setup. S1 uses these for read-only tests; S2-S4
 * will add more fixtures as needed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/** Absolute path to a fixture under `tests/fixtures/stacks/<name>/`. */
export function stackFixturePath(name: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', 'stacks', name);
}

/** Absolute path to the repo root (used by tests that run from cwd). */
export function repoFixturesRoot(): string {
  return path.join(repoRoot, 'tests', 'fixtures');
}
