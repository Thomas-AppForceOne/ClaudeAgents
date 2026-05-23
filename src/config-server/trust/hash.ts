

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort } from '../determinism/index.js';

export interface TrustHashResult {

  aggregateHash: string;

  files: string[];
}

export function computeTrustHash(projectRoot: string): TrustHashResult {
  const ganRoot = path.join(projectRoot, '.claude', 'gan');

  const pendingPaths: string[] = [];

  const projectOverlay = path.join(ganRoot, 'project.md');
  if (isRegularFile(projectOverlay)) {
    pendingPaths.push(projectOverlay);
  }

  const stacksDir = path.join(ganRoot, 'stacks');
  if (isDirectory(stacksDir)) {
    for (const name of safeReaddir(stacksDir)) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(stacksDir, name);
      if (isRegularFile(full)) {
        pendingPaths.push(full);
      }
    }
  }

  const modulesDir = path.join(ganRoot, 'modules');
  if (isDirectory(modulesDir)) {
    for (const name of safeReaddir(modulesDir)) {
      if (!name.endsWith('.yaml')) continue;
      const full = path.join(modulesDir, name);
      if (isRegularFile(full)) {
        pendingPaths.push(full);
      }
    }
  }

  const canonicalised = pendingPaths.map((p) => canonicalizePath(p));
  const sorted = localeSort(canonicalised);

  const hash = createHash('sha256');
  for (const p of sorted) {
    hash.update(readFileSync(p));
  }
  const aggregateHash = 'sha256:' + hash.digest('hex');

  return { aggregateHash, files: sorted };
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
