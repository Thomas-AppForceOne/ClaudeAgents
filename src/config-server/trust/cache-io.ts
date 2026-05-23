

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort, stableStringify } from '../determinism/index.js';
import { createError } from '../errors.js';
import { atomicWriteFile } from '../storage/atomic-write.js';

export interface TrustApproval {
  projectRoot: string;
  aggregateHash: string;
  approvedAt: string;
  approvedCommit?: string;
  note?: string;
}

export interface TrustCache {
  schemaVersion: 1;
  approvals: TrustApproval[];
}

export function getTrustCachePath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'gan', 'trust-cache.json');
}

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

export function writeCache(homeDir: string, cache: TrustCache): void {
  const cachePath = getTrustCachePath(homeDir);
  const parentDir = path.dirname(cachePath);

  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const content = stableStringify(cache);
  atomicWriteFile(cachePath, content);
  chmodSync(cachePath, 0o600);
}

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

export function removeApprovals(cache: TrustCache, projectRoot: string): TrustCache {
  const canonical = canonicalizePath(projectRoot);
  const remaining = cache.approvals.filter((e) => e.projectRoot !== canonical);
  return { schemaVersion: 1, approvals: remaining };
}

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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describeSchemaVersion(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}
