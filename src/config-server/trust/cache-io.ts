/**
 * Persistence layer for the trust-approval cache.
 *
 * The trust cache is a per-user JSON file (`~/.claude/gan/trust-cache.json`)
 * recording which (project root, aggregate config hash) pairs the user has
 * approved for command execution. This module owns its on-disk format and the
 * pure transforms over it; the write tools and the trust check call in here.
 *
 * Three guarantees are enforced here so callers do not have to:
 * 1. **Security posture is validated on read.** The file must be `0600` —
 *    readable/writable only by its owner — or {@link readCache} refuses it
 *    (`TrustCacheCorrupt`), since a world-writable trust file would let another
 *    local user grant themselves command-execution approval.
 * 2. **Stored roots are canonical.** {@link upsertApproval}/{@link
 *    removeApprovals}/{@link lookupApproval} canonicalise the project root, so
 *    a symlinked or differently-spelled path matches its stored approval.
 * 3. **Deterministic, atomic writes.** {@link writeCache} sorts approvals and
 *    serialises deterministically, then writes via temp-file+rename and
 *    re-asserts `0600`, so the file is never half-written or left permissive.
 *
 * Read failures (missing/unreadable/malformed/insecure file) are surfaced as a
 * thrown `TrustCacheCorrupt` {@link ConfigServerError}; a genuinely absent file
 * is *not* an error — it yields an empty cache.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort, stableStringify } from '../determinism/index.js';
import { createError } from '../errors.js';
import { atomicWriteFile } from '../storage/atomic-write.js';

/**
 * A single recorded approval.
 *
 * @property projectRoot the approved project's root; always stored canonical
 *   (callers that construct a record need not pre-canonicalise — the upsert
 *   does it).
 * @property aggregateHash the trust hash that was approved (`sha256:…`); an
 *   approval is valid only while the project's current hash still equals this.
 * @property approvedAt ISO-8601 timestamp of when approval was granted.
 * @property approvedCommit optional git HEAD sha captured at approval time;
 *   omitted when unavailable.
 * @property note optional free-text annotation.
 */
export interface TrustApproval {
  projectRoot: string;
  aggregateHash: string;
  approvedAt: string;
  approvedCommit?: string;
  note?: string;
}

/**
 * The on-disk cache shape.
 *
 * @property schemaVersion pinned to the literal `1`; any other value on read is
 *   treated as corruption (this build understands only version 1).
 * @property approvals the list of approval records.
 */
export interface TrustCache {
  schemaVersion: 1;
  approvals: TrustApproval[];
}

/**
 * Compute the trust-cache file path for a given home directory. Pure path
 * join — does not touch disk.
 *
 * @param homeDir the user home under which `.claude/gan/trust-cache.json` lives.
 */
export function getTrustCachePath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'gan', 'trust-cache.json');
}

/**
 * Read and validate the trust cache for `homeDir`.
 *
 * A missing file is the normal first-run state and returns an empty cache
 * `{ schemaVersion: 1, approvals: [] }` — not an error. Anything else that is
 * wrong throws `TrustCacheCorrupt` ({@link ConfigServerError}), each message
 * naming the file and how to recover (chmod or remove it). The validation
 * order is deliberate: permissions are checked *before* contents, so an
 * insecure file is rejected without its (untrusted) bytes being parsed.
 *
 * Throws `TrustCacheCorrupt` when the file: cannot be `stat`ed; has any
 * group/other permission bits set (must be `0600`); cannot be read; is not
 * valid JSON; is not a JSON object; has `schemaVersion !== 1`; or whose
 * `approvals` is not an array.
 *
 * @param homeDir the user home directory whose cache to read.
 * @returns the parsed cache. Note: individual approval *records* are not
 *   field-validated here — `approvals` is trusted to hold {@link TrustApproval}
 *   shapes once it is confirmed to be an array.
 */
export function readCache(homeDir: string): TrustCache {
  const cachePath = getTrustCachePath(homeDir);
  if (!existsSync(cachePath)) {
    return { schemaVersion: 1, approvals: [] };
  }

  let mode: number;
  try {
    mode = statSync(cachePath).mode;
  } catch (e) {
    throw createError('TrustCacheCorrupt', {
      file: cachePath,
      message:
        `The framework could not stat the trust cache at '${cachePath}': ${
          e instanceof Error ? e.message : String(e)
        }. ` + `Check the file is readable, or remove it (\`rm ${cachePath}\`) to start fresh.`,
      remediation: `Check the file is readable, or remove it (\`rm ${cachePath}\`) to start fresh.`,
    });
  }

  // Reject any group/other permission bit: the trust file gates command
  // execution, so it must be owner-only (0600). A relaxed mode could let
  // another local user inject an approval.
  if ((mode & 0o077) !== 0) {
    throw createError('TrustCacheCorrupt', {
      file: cachePath,
      message:
        `Trust cache file at '${cachePath}' has insecure permissions; the framework requires chmod 0600 ` +
        `so other local users cannot tamper with it. Restore the file mode with \`chmod 0600 ${cachePath}\` ` +
        `or remove it (\`rm ${cachePath}\`) to start fresh.`,
      remediation: `Restore the file mode with \`chmod 0600 ${cachePath}\` or remove it (\`rm ${cachePath}\`) to start fresh.`,
    });
  }

  let text: string;
  try {
    text = readFileSync(cachePath, 'utf8');
  } catch (e) {
    throw createError('TrustCacheCorrupt', {
      file: cachePath,
      message: `The framework could not read the trust cache at '${cachePath}': ${
        e instanceof Error ? e.message : String(e)
      }. Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
      remediation: `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw createError('TrustCacheCorrupt', {
      file: cachePath,
      message:
        `Trust cache file at '${cachePath}' is malformed: ${reason}. ` +
        `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
      remediation: `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
    });
  }

  if (!isObject(parsed)) {
    throw createError('TrustCacheCorrupt', {
      file: cachePath,
      message:
        `Trust cache file at '${cachePath}' is malformed: top-level value is not a JSON object. ` +
        `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
      remediation: `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
    });
  }

  if (parsed['schemaVersion'] !== 1) {
    const got = parsed['schemaVersion'];
    throw createError('TrustCacheCorrupt', {
      file: cachePath,
      message: `Trust cache file at '${cachePath}' is malformed: expected schemaVersion=1 but got ${describeSchemaVersion(
        got,
      )}. Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
      remediation: `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
    });
  }

  const approvals = parsed['approvals'];
  if (!Array.isArray(approvals)) {
    throw createError('TrustCacheCorrupt', {
      file: cachePath,
      message:
        `Trust cache file at '${cachePath}' is malformed: expected 'approvals' to be an array. ` +
        `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
      remediation: `Remove it (\`rm ${cachePath}\`) or fix it manually before re-running.`,
    });
  }

  return { schemaVersion: 1, approvals: approvals as TrustApproval[] };
}

/**
 * Persist `cache` to `homeDir`'s trust file, creating the parent directory if
 * needed.
 *
 * Side effects: creates `~/.claude/gan` with mode `0700` if absent, serialises
 * the cache deterministically ({@link stableStringify}, so byte-identical state
 * produces a byte-identical file), writes it atomically (temp-file + rename, so
 * a crash cannot leave a half-written cache), then `chmod`s the result to
 * `0600`. The explicit chmod-after-write re-establishes the owner-only mode that
 * {@link readCache} requires regardless of the process umask.
 *
 * Throws on an underlying I/O error from the directory create, atomic write, or
 * chmod (propagated unchanged). The caller is responsible for passing a cache
 * with canonical roots (use {@link upsertApproval}/{@link removeApprovals}).
 *
 * @param homeDir the user home to write under.
 * @param cache the cache to persist.
 */
export function writeCache(homeDir: string, cache: TrustCache): void {
  const cachePath = getTrustCachePath(homeDir);
  const parentDir = path.dirname(cachePath);

  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const content = stableStringify(cache);
  atomicWriteFile(cachePath, content);
  // Re-assert owner-only mode after the write so the file always satisfies the
  // 0600 precondition readCache enforces, independent of the umask.
  chmodSync(cachePath, 0o600);
}

/**
 * Find the approval matching both `projectRoot` (canonicalised before
 * comparison, so a symlinked spelling still matches) and `aggregateHash`. Pure
 * lookup; no I/O.
 *
 * @returns the matching {@link TrustApproval}, or `undefined` when none matches
 *   on *both* root and hash — a stored approval whose hash differs is not a
 *   match (the config changed since approval).
 */
export function lookupApproval(
  cache: TrustCache,
  projectRoot: string,
  aggregateHash: string,
): TrustApproval | undefined {
  const canonical = canonicalizePath(projectRoot);
  for (const entry of cache.approvals) {
    if (entry.projectRoot === canonical && entry.aggregateHash === aggregateHash) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Return a *new* cache with `record` inserted, replacing any existing approval
 * with the same (canonical root, hash). The input cache is not mutated.
 *
 * The record's root is canonicalised before storing, so all persisted roots are
 * canonical. Uniqueness is on the (root, hash) pair — re-approving the same
 * project at the same hash overwrites in place rather than duplicating; the same
 * project at a *new* hash adds a second record. The result is re-sorted for a
 * deterministic on-disk order.
 *
 * @param cache the current cache (read-only here).
 * @param record the approval to add or replace; its `projectRoot` may be raw.
 * @returns a fresh, sorted cache including `record`.
 */
export function upsertApproval(cache: TrustCache, record: TrustApproval): TrustCache {
  const canonicalRecord: TrustApproval = {
    ...record,
    projectRoot: canonicalizePath(record.projectRoot),
  };
  const filtered = cache.approvals.filter(
    (e) =>
      !(
        e.projectRoot === canonicalRecord.projectRoot &&
        e.aggregateHash === canonicalRecord.aggregateHash
      ),
  );
  const merged = [...filtered, canonicalRecord];
  const sorted = sortApprovals(merged);
  return { schemaVersion: 1, approvals: sorted };
}

/**
 * Return a *new* cache with every approval for `projectRoot` removed,
 * regardless of hash. The input cache is not mutated.
 *
 * The root is canonicalised before matching, so it removes approvals stored
 * under any spelling of the same directory. Removing all hashes (not just the
 * current one) means a revoke clears every pinned approval for the project.
 *
 * @param cache the current cache (read-only here).
 * @param projectRoot the project whose approvals to drop; may be raw.
 * @returns a fresh cache without that project's approvals (unchanged contents
 *   when it had none).
 */
export function removeApprovals(cache: TrustCache, projectRoot: string): TrustCache {
  const canonical = canonicalizePath(projectRoot);
  const remaining = cache.approvals.filter((e) => e.projectRoot !== canonical);
  return { schemaVersion: 1, approvals: remaining };
}

/**
 * Sort approvals into a stable on-disk order keyed by `projectRoot +
 * aggregateHash`.
 *
 * The key concatenation is unambiguous in practice because the hash half has a
 * fixed `sha256:`-prefixed length, so the boundary between root and hash is
 * well-defined. The implementation sorts the *keys* via `localeSort` (the
 * project's locale-stable comparator) and then reattaches records by matching
 * key, splicing each consumed entry out of `remaining` so duplicate keys (same
 * root+hash — which upsert already prevents) map to distinct records rather
 * than aliasing one.
 */
function sortApprovals(approvals: readonly TrustApproval[]): TrustApproval[] {

  const keyed = approvals.map((entry) => ({
    key: entry.projectRoot + entry.aggregateHash,
    entry,
  }));
  const sortedKeys = localeSort(keyed.map((k) => k.key));

  const remaining = keyed.slice();
  const out: TrustApproval[] = [];
  for (const k of sortedKeys) {
    const idx = remaining.findIndex((r) => r.key === k);
    if (idx >= 0) {
      out.push(remaining[idx].entry);
      remaining.splice(idx, 1);
    }
  }
  return out;
}

/** Narrow to a non-null, non-array object (a parsed JSON object). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Render a bad `schemaVersion` value for an error message, quoting strings and
 * spelling out `undefined`, so the diagnostic distinguishes `"1"` (a string)
 * from `1` (the expected number) and a missing field from a present-but-wrong
 * one.
 */
function describeSchemaVersion(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}
