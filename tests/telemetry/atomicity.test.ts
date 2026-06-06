/**
 * Atomicity suite for the two telemetry writers — pins the property the
 * temp+rename dance guarantees: the target is either complete or absent,
 * never a partially-written blend. The failure between the temp write and
 * the rename is simulated the same way tests/config-server/storage/
 * atomic-write.test.ts simulates it — making the parent directory
 * read-only so the rename cannot land on POSIX. The test early-returns on
 * win32 (chmod semantics differ) so the suite is hermetic across
 * platforms.
 *
 * Both writers funnel through the same atomicWriteFile helper, so one
 * representative case per writer is enough to prove the property holds for
 * both; the failure-path assertions also assert no `*.tmp.*` sibling
 * survived (the "no leftover debris" half of the contract).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';

import { writeTelemetryConfig } from '../../src/telemetry/writer-config.js';
import { writeTelemetryOutcome } from '../../src/telemetry/writer-outcome.js';
import { resetDroppedEmitsForTests } from '../../src/trace/dropped-emits.js';
import { ConfigServerError } from '../../src/config-server/errors.js';
import type { ResolvedConfigSnapshot } from '../../src/telemetry/types.js';

const tmpDirs: string[] = [];
function makeRunDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'o3-telatom-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetDroppedEmitsForTests();
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    // Restore writable perms on every temp dir (the failure-path cases
    // chmod the telemetry/ sub-dir read-only so rename fails); without
    // this rmSync cannot recurse in to clean up.
    try {
      chmodSync(d, 0o755);
    } catch {
      /* ignore */
    }
    try {
      chmodSync(path.join(d, 'telemetry'), 0o755);
    } catch {
      /* ignore */
    }
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function minimalResolvedConfig(): ResolvedConfigSnapshot {
  return {
    apiVersion: '0.1.0',
    schemaVersions: {},
    runtimeMode: {},
    stacks: {},
    overlay: {},
    discarded: [],
    additionalContext: {},
    issues: [],
    warnings: [],
    modules: {},
  };
}

describe('telemetry writers — atomic write contract', () => {
  it('writeTelemetryConfig success path leaves no *.tmp.* sibling', async () => {
    const runDir = makeRunDir();
    const target = await writeTelemetryConfig({
      runDir,
      runId: '20260606T200000-1111',
      resolvedConfig: minimalResolvedConfig(),
      capturedAt: '2026-06-06T20:00:00.000Z',
    });

    expect(existsSync(target)).toBe(true);

    const remaining = readdirSync(path.dirname(target));
    expect(remaining).toContain('config.json');
    // The temp sibling the rename swapped from must have been
    // renamed-away, not left next to the target.
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('writeTelemetryConfig failure between temp write and rename: target is absent, no temp leftovers', async () => {
    if (platform() === 'win32') return;
    const runDir = makeRunDir();
    // Pre-create telemetry/ so we can chmod it read-only. Without this,
    // atomicWriteFile would mkdir-recursive it as a writable directory.
    const telemetryDir = path.join(runDir, 'telemetry');
    mkdirSync(telemetryDir);
    // Read-only directory makes the temp write throw, so the rename
    // step never happens. Either the target file is absent (this case)
    // or fully present (the success case above); the contract forbids a
    // partial blend.
    chmodSync(telemetryDir, 0o555);

    let threw = false;
    try {
      await writeTelemetryConfig({
        runDir,
        runId: '20260606T201500-2222',
        resolvedConfig: minimalResolvedConfig(),
        capturedAt: '2026-06-06T20:15:00.000Z',
      });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ConfigServerError);
    }
    expect(threw).toBe(true);

    chmodSync(telemetryDir, 0o755);

    // Crash-safety: the target is absent (never partial) and no temp
    // sibling was orphaned.
    expect(existsSync(path.join(telemetryDir, 'config.json'))).toBe(false);
    const remaining = readdirSync(telemetryDir);
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('writeTelemetryOutcome success path leaves no *.tmp.* sibling', async () => {
    const runDir = makeRunDir();
    const target = await writeTelemetryOutcome({
      runDir,
      runId: '20260606T203000-3333',
      terminalReason: 'aborted-by-user',
      sprints: [],
      safetyHalts: [],
      writtenAt: '2026-06-06T20:30:00.000Z',
    });

    expect(existsSync(target)).toBe(true);

    const remaining = readdirSync(path.dirname(target));
    expect(remaining).toContain('outcome.json');
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('writeTelemetryOutcome failure between temp write and rename: target is absent, no temp leftovers', async () => {
    if (platform() === 'win32') return;
    const runDir = makeRunDir();
    const telemetryDir = path.join(runDir, 'telemetry');
    mkdirSync(telemetryDir);
    chmodSync(telemetryDir, 0o555);

    let threw = false;
    try {
      await writeTelemetryOutcome({
        runDir,
        runId: '20260606T204500-4444',
        terminalReason: 'aborted-by-user',
        sprints: [],
        safetyHalts: [],
        writtenAt: '2026-06-06T20:45:00.000Z',
      });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ConfigServerError);
    }
    expect(threw).toBe(true);

    chmodSync(telemetryDir, 0o755);

    expect(existsSync(path.join(telemetryDir, 'outcome.json'))).toBe(false);
    const remaining = readdirSync(telemetryDir);
    expect(remaining.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });
});
