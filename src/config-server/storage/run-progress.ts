/**
 * F7 slice 2 — recording the resolved workspace into `progress.json`.
 *
 * At run start the orchestrator persists the resolved workspace so recovery
 * (O2), confinement (§3), and cleanup (§4) can find the worktree the run must
 * resume into. The recorded shape (F7 spec §2 / "Schema additions"):
 *
 *   "workspace": {
 *     "worktreePath": <canonical absolute path — the recovery anchor>,
 *     "branch":       <resolved branch name>,
 *     "createdByGan": <boolean — true only for cases 1b/1c>
 *   }
 *
 * `worktreePath` is canonicalised through the centralised determinism module
 * ({@link canonicalizePath}); this module never re-implements
 * realpath / case-folding / slash-stripping. The write goes through the
 * shared `atomicWriteFile` (temp-file + rename) and `stableStringify` (sorted
 * keys, two-space indent, trailing newline) so the file is never observed
 * half-written and is byte-deterministic. The merge is a fixed-shape,
 * own-keys-only assignment — no untrusted key is merged into the object or its
 * prototype.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from './atomic-write.js';
import { canonicalizePath, stableStringify } from '../determinism/index.js';
import type { ResolvedWorkspace } from './worktree-resolver.js';

/** The persisted `workspace` block. */
export interface WorkspaceRecord {
  /** Canonical absolute worktree path (the recovery anchor). */
  worktreePath: string;
  /** The resolved branch name. */
  branch: string;
  /** True only for cases 1b/1c. */
  createdByGan: boolean;
}

/**
 * Build the `workspace` record from a resolved workspace, canonicalising the
 * worktree path through the centralised determinism module.
 */
export function buildWorkspaceRecord(resolved: ResolvedWorkspace): WorkspaceRecord {
  return {
    worktreePath: canonicalizePath(resolved.worktreePath),
    branch: resolved.branch,
    createdByGan: resolved.createdByGan,
  };
}

/**
 * Record the resolved workspace into `progress.json` at `progressPath`. If the
 * file already exists and parses to an object, the `workspace` key is set on a
 * shallow copy of it (every other field is preserved); otherwise a fresh
 * object is written. Returns the record that was written.
 *
 * Only the fixed three `workspace` fields are assigned — no key derived from
 * untrusted input is merged into the object or its prototype.
 */
export function recordWorkspace(
  progressPath: string,
  resolved: ResolvedWorkspace,
): WorkspaceRecord {
  const record = buildWorkspaceRecord(resolved);
  const base = readProgressObject(progressPath);
  const next: Record<string, unknown> = { ...base, workspace: record };
  atomicWriteFile(progressPath, stableStringify(next));
  return record;
}

/**
 * Read an existing `progress.json` into a plain object, or return an empty
 * object when the file is absent or unparseable. Dangerous prototype-polluting
 * keys (`__proto__`, `constructor`, `prototype`) are stripped defensively so a
 * pre-existing malformed file cannot pollute the merged object.
 */
function readProgressObject(progressPath: string): Record<string, unknown> {
  if (!existsSync(progressPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(progressPath, 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = v;
  }
  return out;
}
