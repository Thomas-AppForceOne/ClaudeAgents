/**
 * Trust cache reader/writer (R5 sprint 2).
 *
 * The trust cache is a small JSON document that records the user's
 * approvals for project overlays. Each approval pairs a canonicalised
 * project root with the aggregate hash (per `trust/hash.ts`) the user
 * approved. When the framework next loads the project, it recomputes the
 * hash and looks it up here; a match means the project is still trusted,
 * a miss means the user must re-approve.
 *
 * This module is pure (no module-level mutable state) and synchronous —
 * trust runs early in the request path and must be order-deterministic.
 *
 * On-disk shape:
 *
 *   {
 *     "schemaVersion": 1,
 *     "approvals": [
 *       { "projectRoot": "/abs/canonical/path",
 *         "aggregateHash": "sha256:...",
 *         "approvedAt": "ISO-8601",
 *         "approvedCommit": "sha (optional)",
 *         "note": "(optional)" }
 *     ]
 *   }
 *
 * The file lives at `~/.claude/gan/trust-cache.json`. Permissions are
 * locked to mode `0600` (owner read/write only). A file with broader
 * permissions is treated as corrupt and rejected — it could have been
 * tampered with by another local user, and trusting it would defeat the
 * purpose. Restore the file mode (`chmod 0600`) or remove the file to
 * start fresh.
 *
 * Determinism:
 *   - On-disk JSON is written via `stableStringify` (sorted keys,
 *     two-space indent, trailing newline). Two writes with the same
 *     input produce byte-identical output.
 *   - Approvals are sorted by `<projectRoot><aggregateHash>` via
 *     `localeSort` after every upsert so writers and readers always see
 *     the same order regardless of insertion sequence.
 *
 * IO discipline:
 *   - Writes go through `atomicWriteFile` — never a raw `writeFileSync`.
 *   - Paths are canonicalised via `canonicalizePath` — never a raw
 *     `realpathSync`.
 *   - Errors are constructed via `createError` — never a raw `throw new
 *     Error`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort, stableStringify } from '../determinism/index.js';
import { createError } from '../errors.js';
import { atomicWriteFile } from '../storage/atomic-write.js';

/**
 * A single trust approval entry. `projectRoot` is the canonical
 * (post-`canonicalizePath`) absolute path of the project. `aggregateHash`
 * is the value returned by `computeTrustHash(projectRoot).aggregateHash`
 * at the moment the user approved the project.
 */
export interface TrustApproval {
  projectRoot: string;
  aggregateHash: string;
  approvedAt: string;
  approvedCommit?: string;
  note?: string;
}

/**
 * The on-disk trust cache document. `schemaVersion` is pinned to `1` —
 * a non-`1` value is treated as `TrustCacheCorrupt` (per F3's exact-match
 * rule).
 */
export interface TrustCache {
  schemaVersion: 1;
  approvals: TrustApproval[];
}

/**
 * Resolve the absolute path of the trust cache file given a home
 * directory. Tests inject a temporary `homeDir`; production callers pass
 * `os.homedir()`.
 */
export function getTrustCachePath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'gan', 'trust-cache.json');
}

/**
 * Read the trust cache from disk. A missing file is *not* an error —
 * this is the first-run case and the function returns the empty cache
 * `{ schemaVersion: 1, approvals: [] }` without writing anything to
 * disk.
 *
 * Errors are surfaced as `TrustCacheCorrupt`:
 *   - the file mode permits group/world access (i.e. mode bits other
 *     than the owner triplet are set),
 *   - the file bytes do not parse as JSON,
 *   - the parsed document is not an object, lacks `schemaVersion: 1`,
 *     or lacks an `approvals` array.
 *
 * In each error case the message names the file path and includes a
 * shell remediation (`chmod 0600 …` or `rm …`).
 */
export function readCache(homeDir: string): TrustCache {
  const cachePath = getTrustCachePath(homeDir);
  if (!existsSync(cachePath)) {
    return { schemaVersion: 1, approvals: [] };
  }

  // Mode check first — a too-permissive file is a security failure even
  // before we look at its contents. A foreign user with write access to
  // the file could insert a fake approval.
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
 * Persist the trust cache to disk. Creates `~/.claude/gan/` (recursive,
 * mode 0700) if needed, writes the cache atomically via
 * `atomicWriteFile`, then locks the file mode to 0600.
 *
 * Output bytes are produced by `stableStringify` (F3 determinism) so
 * two `writeCache` calls with the same input produce byte-identical
 * files.
 */
export function writeCache(homeDir: string, cache: TrustCache): void {
  const cachePath = getTrustCachePath(homeDir);
  const parentDir = path.dirname(cachePath);
  // Recursive mkdir — owner-only mode for the parent dir for the same
  // reason the file gets 0600: keep other local users out.
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const content = stableStringify(cache);
  atomicWriteFile(cachePath, content);
  chmodSync(cachePath, 0o600);
}

/**
 * Look up an approval by `(projectRoot, aggregateHash)`. Returns the
 * matching `TrustApproval` or `undefined`.
 *
 * `projectRoot` is canonicalised before comparison so callers that pass
 * a non-canonical path (e.g. with a trailing slash, mixed case on
 * Darwin, or a symlink) still hit the canonical entry stored in the
 * cache. The hash is compared byte-for-byte; trust hashes are already
 * canonical strings, no normalisation is needed.
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
 * Insert or replace an approval. Returns a *new* cache; the input is
 * not mutated (the input's `approvals` array is left untouched, callers
 * may rely on that for snapshot/diff comparisons).
 *
 * If an existing entry matches `(projectRoot, aggregateHash)`, it is
 * replaced (only one approval is kept per pair). The result is sorted
 * by `<projectRoot><aggregateHash>` under `localeSort` so on-disk byte
 * order is independent of insertion order — required for the
 * round-trip determinism guarantee.
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
 * Remove every approval for the given project root. Returns a *new*
 * cache; the input is not mutated. Existing entries that survive the
 * filter keep their original order — no resort, since removing a row
 * cannot disturb the sort order of the rows that remain.
 *
 * `projectRoot` is canonicalised before comparison so callers can pass
 * a non-canonical path and still revoke the canonical entry.
 */
export function removeApprovals(cache: TrustCache, projectRoot: string): TrustCache {
  const canonical = canonicalizePath(projectRoot);
  const remaining = cache.approvals.filter((e) => e.projectRoot !== canonical);
  return { schemaVersion: 1, approvals: remaining };
}

// ---- helpers --------------------------------------------------------------

function sortApprovals(approvals: readonly TrustApproval[]): TrustApproval[] {
  // Build sort keys via the documented composition; localeSort returns
  // the keys sorted, so we map back to the original entries by index
  // through a parallel-array zip.
  const keyed = approvals.map((entry) => ({
    key: entry.projectRoot + entry.aggregateHash,
    entry,
  }));
  const sortedKeys = localeSort(keyed.map((k) => k.key));
  // For duplicate keys (same projectRoot+hash), localeSort is stable;
  // we deduplicate by consuming one entry per key in declaration order.
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Render a `schemaVersion` value for inclusion in an error message
 * without going through `JSON.stringify` (the cache-io module is
 * `stableStringify`-only by contract). Strings are quoted; everything
 * else uses `String(...)`.
 */
function describeSchemaVersion(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}
