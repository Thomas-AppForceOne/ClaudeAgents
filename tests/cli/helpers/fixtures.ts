/**
 * Path helpers for locating the CLI tests' on-disk fixtures.
 *
 * Centralises the `tests/fixtures` layout in one place so the test suites refer
 * to fixture projects by name rather than hard-coding repo-relative paths, and
 * so a future relocation of the fixtures tree is a one-line change here.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this compiled file's location (dist/.../helpers): three levels
// up is the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * Absolute path to a fixture project under `tests/fixtures/stacks/`.
 *
 * @param name the fixture directory name (e.g. `'js-ts-minimal'`,
 *   `'polyglot-webnode-synthetic'`, `'trust-command-files'`).
 * @returns the absolute path; existence is the caller's concern (not checked).
 */
export function stackFixturePath(name: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', 'stacks', name);
}

/** Absolute path to the root of the `tests/fixtures` tree. */
export function repoFixturesRoot(): string {
  return path.join(repoRoot, 'tests', 'fixtures');
}
