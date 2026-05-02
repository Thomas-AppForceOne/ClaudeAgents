import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  getTrustCachePath,
  lookupApproval,
  readCache,
  removeApprovals,
  upsertApproval,
  writeCache,
  type TrustApproval,
  type TrustCache,
} from '../../../src/config-server/trust/cache-io.js';
import { canonicalizePath, stableStringify } from '../../../src/config-server/determinism/index.js';
import { ConfigServerError } from '../../../src/config-server/errors.js';

describe('trust/cache-io', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'r5-cache-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function sampleApproval(overrides: Partial<TrustApproval> = {}): TrustApproval {
    return {
      projectRoot: canonicalizePath(homeDir),
      aggregateHash: 'sha256:' + 'a'.repeat(64),
      approvedAt: '2026-05-01T00:00:00.000Z',
      ...overrides,
    };
  }

  describe('getTrustCachePath', () => {
    it('joins homeDir/.claude/gan/trust-cache.json', () => {
      const expected = path.join(homeDir, '.claude', 'gan', 'trust-cache.json');
      expect(getTrustCachePath(homeDir)).toBe(expected);
    });
  });

  describe('readCache', () => {
    it('returns the empty cache for a missing file and does not write to disk', () => {
      const cache = readCache(homeDir);
      expect(cache).toEqual({ schemaVersion: 1, approvals: [] });
      expect(existsSync(getTrustCachePath(homeDir))).toBe(false);
    });

    it('throws TrustCacheCorrupt when file mode permits group/world access', () => {
      const cachePath = getTrustCachePath(homeDir);
      mkdirSync(path.dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, '{"schemaVersion":1,"approvals":[]}\n', 'utf8');
      chmodSync(cachePath, 0o644);

      let caught: unknown = null;
      try {
        readCache(homeDir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigServerError);
      const err = caught as ConfigServerError;
      expect(err.code).toBe('TrustCacheCorrupt');
      expect(err.message).toContain('chmod 0600');
      expect(err.file).toBe(cachePath);
    });

    it('throws TrustCacheCorrupt when JSON is malformed', () => {
      const cachePath = getTrustCachePath(homeDir);
      mkdirSync(path.dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, '{not-json', 'utf8');
      chmodSync(cachePath, 0o600);

      let caught: unknown = null;
      try {
        readCache(homeDir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigServerError);
      expect((caught as ConfigServerError).code).toBe('TrustCacheCorrupt');
      expect((caught as ConfigServerError).message).toContain('malformed');
    });

    it('throws TrustCacheCorrupt when top-level is not an object', () => {
      const cachePath = getTrustCachePath(homeDir);
      mkdirSync(path.dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, '[]\n', 'utf8');
      chmodSync(cachePath, 0o600);

      expect(() => readCache(homeDir)).toThrowError(/TrustCacheCorrupt|malformed/);
    });

    it('throws TrustCacheCorrupt when schemaVersion is not 1', () => {
      const cachePath = getTrustCachePath(homeDir);
      mkdirSync(path.dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, '{"schemaVersion":2,"approvals":[]}\n', 'utf8');
      chmodSync(cachePath, 0o600);

      let caught: unknown = null;
      try {
        readCache(homeDir);
      } catch (e) {
        caught = e;
      }
      expect((caught as ConfigServerError).code).toBe('TrustCacheCorrupt');
    });

    it('throws TrustCacheCorrupt when approvals is not an array', () => {
      const cachePath = getTrustCachePath(homeDir);
      mkdirSync(path.dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, '{"schemaVersion":1,"approvals":{}}\n', 'utf8');
      chmodSync(cachePath, 0o600);

      let caught: unknown = null;
      try {
        readCache(homeDir);
      } catch (e) {
        caught = e;
      }
      expect((caught as ConfigServerError).code).toBe('TrustCacheCorrupt');
    });

    it('reads a valid empty cache', () => {
      const cachePath = getTrustCachePath(homeDir);
      mkdirSync(path.dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, '{"schemaVersion":1,"approvals":[]}\n', 'utf8');
      chmodSync(cachePath, 0o600);

      expect(readCache(homeDir)).toEqual({ schemaVersion: 1, approvals: [] });
    });
  });

  describe('writeCache', () => {
    it('creates the file with mode 0600 on first write', () => {
      const cache: TrustCache = { schemaVersion: 1, approvals: [sampleApproval()] };
      writeCache(homeDir, cache);

      const cachePath = getTrustCachePath(homeDir);
      expect(existsSync(cachePath)).toBe(true);
      const stat = statSync(cachePath);
      // Lower 9 bits should be 0o600.
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('writes content equal to stableStringify byte-for-byte', () => {
      const cache: TrustCache = { schemaVersion: 1, approvals: [sampleApproval()] };
      writeCache(homeDir, cache);

      const cachePath = getTrustCachePath(homeDir);
      const onDisk = readFileSync(cachePath, 'utf8');
      // After upsertApproval the approvals would be sorted, but writeCache
      // does not mutate; it serialises the exact `cache` argument.
      expect(onDisk).toBe(stableStringify(cache));
    });

    it('preserves mode 0600 on subsequent writes', () => {
      const cache1: TrustCache = { schemaVersion: 1, approvals: [sampleApproval()] };
      writeCache(homeDir, cache1);

      const cache2: TrustCache = {
        schemaVersion: 1,
        approvals: [
          sampleApproval(),
          sampleApproval({ aggregateHash: 'sha256:' + 'b'.repeat(64) }),
        ],
      };
      writeCache(homeDir, cache2);

      const cachePath = getTrustCachePath(homeDir);
      const stat = statSync(cachePath);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(readFileSync(cachePath, 'utf8')).toBe(stableStringify(cache2));
    });

    it('produces byte-identical output for identical input', () => {
      const cache: TrustCache = {
        schemaVersion: 1,
        approvals: [
          sampleApproval({ projectRoot: '/aaa', aggregateHash: 'sha256:' + '1'.repeat(64) }),
          sampleApproval({ projectRoot: '/bbb', aggregateHash: 'sha256:' + '2'.repeat(64) }),
        ],
      };
      const cachePath = getTrustCachePath(homeDir);
      writeCache(homeDir, cache);
      const first = readFileSync(cachePath, 'utf8');
      writeCache(homeDir, cache);
      const second = readFileSync(cachePath, 'utf8');
      expect(first).toBe(second);
    });

    it('round-trips: writeCache then readCache returns deep-equal value', () => {
      const cache: TrustCache = {
        schemaVersion: 1,
        approvals: [
          sampleApproval({
            projectRoot: '/a/b/c',
            aggregateHash: 'sha256:' + '3'.repeat(64),
            approvedCommit: 'deadbeef',
            note: 'hello',
          }),
        ],
      };
      writeCache(homeDir, cache);
      const read = readCache(homeDir);
      expect(read).toEqual(cache);
    });
  });

  describe('lookupApproval', () => {
    it('returns the matching entry when both projectRoot and hash match', () => {
      const root = canonicalizePath(homeDir);
      const entry = sampleApproval({ projectRoot: root, aggregateHash: 'sha256:abc' });
      const cache: TrustCache = { schemaVersion: 1, approvals: [entry] };
      expect(lookupApproval(cache, root, 'sha256:abc')).toEqual(entry);
    });

    it('returns undefined when no entry matches', () => {
      const root = canonicalizePath(homeDir);
      const cache: TrustCache = {
        schemaVersion: 1,
        approvals: [sampleApproval({ projectRoot: root, aggregateHash: 'sha256:abc' })],
      };
      expect(lookupApproval(cache, root, 'sha256:zzz')).toBeUndefined();
      expect(lookupApproval(cache, '/no/such/path', 'sha256:abc')).toBeUndefined();
    });

    it('canonicalises the projectRoot lookup so non-canonical input still hits canonical entry', () => {
      // Build an entry keyed off the canonical homeDir.
      const canonical = canonicalizePath(homeDir);
      const entry = sampleApproval({ projectRoot: canonical, aggregateHash: 'sha256:abc' });
      const cache: TrustCache = { schemaVersion: 1, approvals: [entry] };
      // Pass the un-canonicalised homeDir (with a trailing slash) — should
      // still resolve to the canonical form and match.
      const queryWithSlash = homeDir.endsWith(path.sep) ? homeDir : homeDir + path.sep;
      expect(lookupApproval(cache, queryWithSlash, 'sha256:abc')).toEqual(entry);
    });
  });

  describe('upsertApproval', () => {
    it('does not mutate the input cache', () => {
      const cache: TrustCache = { schemaVersion: 1, approvals: [] };
      const before = JSON.parse(JSON.stringify(cache));
      const next = upsertApproval(cache, sampleApproval({ projectRoot: '/x' }));
      expect(cache).toEqual(before);
      expect(next).not.toBe(cache);
      expect(next.approvals).not.toBe(cache.approvals);
    });

    it('appends a new entry (length+1) when no match exists', () => {
      const a = sampleApproval({ projectRoot: '/a', aggregateHash: 'sha256:a' });
      const cache: TrustCache = { schemaVersion: 1, approvals: [a] };
      const next = upsertApproval(
        cache,
        sampleApproval({ projectRoot: '/b', aggregateHash: 'sha256:b' }),
      );
      expect(next.approvals.length).toBe(2);
    });

    it('replaces an existing entry (length stays) when (projectRoot, hash) match', () => {
      const a = sampleApproval({
        projectRoot: '/a',
        aggregateHash: 'sha256:same',
        approvedAt: '2026-01-01T00:00:00.000Z',
      });
      const cache: TrustCache = { schemaVersion: 1, approvals: [a] };
      const replacement = sampleApproval({
        projectRoot: '/a',
        aggregateHash: 'sha256:same',
        approvedAt: '2026-05-01T00:00:00.000Z',
        note: 'updated',
      });
      const next = upsertApproval(cache, replacement);
      expect(next.approvals.length).toBe(1);
      expect(next.approvals[0].approvedAt).toBe('2026-05-01T00:00:00.000Z');
      expect(next.approvals[0].note).toBe('updated');
    });

    it('sorts approvals by projectRoot+aggregateHash via localeSort', () => {
      let cache: TrustCache = { schemaVersion: 1, approvals: [] };
      cache = upsertApproval(
        cache,
        sampleApproval({ projectRoot: '/zzz', aggregateHash: 'sha256:1' }),
      );
      cache = upsertApproval(
        cache,
        sampleApproval({ projectRoot: '/aaa', aggregateHash: 'sha256:9' }),
      );
      cache = upsertApproval(
        cache,
        sampleApproval({ projectRoot: '/mmm', aggregateHash: 'sha256:5' }),
      );
      const roots = cache.approvals.map((a) => a.projectRoot);
      expect(roots).toEqual(['/aaa', '/mmm', '/zzz']);
    });
  });

  describe('removeApprovals', () => {
    it('does not mutate the input cache', () => {
      const a = sampleApproval({ projectRoot: '/a' });
      const cache: TrustCache = { schemaVersion: 1, approvals: [a] };
      const before = JSON.parse(JSON.stringify(cache));
      removeApprovals(cache, '/a');
      expect(cache).toEqual(before);
    });

    it('removes only entries whose projectRoot matches', () => {
      const a1 = sampleApproval({ projectRoot: '/a', aggregateHash: 'sha256:1' });
      const a2 = sampleApproval({ projectRoot: '/a', aggregateHash: 'sha256:2' });
      const b = sampleApproval({ projectRoot: '/b', aggregateHash: 'sha256:3' });
      const cache: TrustCache = { schemaVersion: 1, approvals: [a1, b, a2] };
      const next = removeApprovals(cache, '/a');
      expect(next.approvals.length).toBe(1);
      expect(next.approvals[0]).toEqual(b);
    });

    it('preserves order of remaining entries', () => {
      const x = sampleApproval({ projectRoot: '/x', aggregateHash: 'sha256:x' });
      const y = sampleApproval({ projectRoot: '/y', aggregateHash: 'sha256:y' });
      const z = sampleApproval({ projectRoot: '/z', aggregateHash: 'sha256:z' });
      const target = sampleApproval({ projectRoot: '/target', aggregateHash: 'sha256:t' });
      const cache: TrustCache = { schemaVersion: 1, approvals: [x, target, y, z] };
      const next = removeApprovals(cache, '/target');
      expect(next.approvals.map((a) => a.projectRoot)).toEqual(['/x', '/y', '/z']);
    });

    it('canonicalises the projectRoot before comparison', () => {
      const canonical = canonicalizePath(homeDir);
      const entry = sampleApproval({ projectRoot: canonical, aggregateHash: 'sha256:abc' });
      const cache: TrustCache = { schemaVersion: 1, approvals: [entry] };
      const queryWithSlash = homeDir.endsWith(path.sep) ? homeDir : homeDir + path.sep;
      const next = removeApprovals(cache, queryWithSlash);
      expect(next.approvals.length).toBe(0);
    });
  });
});
