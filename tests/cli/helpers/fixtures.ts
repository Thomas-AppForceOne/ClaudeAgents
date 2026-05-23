
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

export function stackFixturePath(name: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', 'stacks', name);
}

export function repoFixturesRoot(): string {
  return path.join(repoRoot, 'tests', 'fixtures');
}
