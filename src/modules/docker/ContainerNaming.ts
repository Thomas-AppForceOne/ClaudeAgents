

import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalizePath } from '../../config-server/determinism/index.js';

export type NameForWorktreeOptions = Record<string, never>;

export function nameForWorktree(
  worktreePath: string,
  _options: NameForWorktreeOptions = {},
): string {

  const last = path.basename(worktreePath) || worktreePath;

  let core = last.toLowerCase();

  core = core.replace(/[^a-z0-9_.\-]/g, '-');

  core = core.replace(/-+/g, '-');

  core = core.replace(/^[^a-z0-9]+/, '');

  const canonical = canonicalizePath(worktreePath);
  const hex = createHash('sha256').update(canonical).digest('hex').slice(0, 4);

  return `${core}-${hex}`;
}
