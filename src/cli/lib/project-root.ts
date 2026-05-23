

import { existsSync, statSync } from 'node:fs';

import {
  canonicalizePath,
  canonicalizePathForDisplay,
} from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';

export interface ResolvedProjectRoot {

  path: string;

  displayPath: string;

  explicit: boolean;
}

export function resolveProjectRoot(flag: string | undefined): ResolvedProjectRoot {
  const explicit = flag !== undefined && flag.length > 0;
  const raw = explicit ? flag! : process.cwd();
  if (!existsSync(raw)) {
    throw createError('MissingFile', {
      path: raw,
      message: `--project-root path does not exist: ${raw}`,
    });
  }
  const st = statSync(raw);
  if (!st.isDirectory()) {
    throw createError('MalformedInput', {
      path: raw,
      message: `--project-root path is not a directory: ${raw}`,
    });
  }
  return {
    path: canonicalizePath(raw),
    displayPath: canonicalizePathForDisplay(raw),
    explicit,
  };
}
