/**
 * writeTelemetryConfig — end-to-end shape and schema-validation suite.
 *
 * Constructs a fabricated ResolvedConfig exercising all ten F2 required
 * fields, drives the writer against a temp runDir, parses the emitted file
 * back, validates it against the bundled telemetryConfigV1 schema, and
 * asserts the envelope embeds the supplied runId and capturedAt verbatim.
 *
 * The ajv-loader idiom matches the rest of the project's bundled-schema
 * tests (see tests/schemas/progress-v1.test.ts) so an ESM/CJS interop drift
 * is caught the same way.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AjvImport, { type ValidateFunction } from 'ajv';

import { writeTelemetryConfig } from '../../src/telemetry/writer-config.js';
import { telemetryConfigV1 } from '../../src/config-server/schemas-bundled.js';
import type { ResolvedConfigSnapshot } from '../../src/telemetry/types.js';

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

const tmpDirs: string[] = [];

function makeRunDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'o3-telcfg-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// All ten F2 required fields populated with minimal-but-valid values. The
// fabricated values are placeholders (no real overlays, no real stacks) —
// the schema only requires the ten keys to exist with the right top-level
// type, not a specific inner shape.
function fabricatedResolvedConfig(): ResolvedConfigSnapshot {
  return {
    apiVersion: '0.1.0',
    schemaVersions: { overlay: 1, stack: 1 },
    runtimeMode: { noProjectCommands: false },
    stacks: { active: [], byName: {} },
    overlay: {},
    discarded: [],
    additionalContext: { planner: [], proposer: [] },
    issues: [],
    warnings: [],
    modules: {},
  };
}

describe('writeTelemetryConfig — envelope + schema validation', () => {
  it('writes a config.json that validates against telemetryConfigV1', async () => {
    const runDir = makeRunDir();
    const runId = '20260606T180000-aaaa';
    const capturedAt = '2026-06-06T18:00:00.001Z';
    const resolvedConfig = fabricatedResolvedConfig();

    const target = await writeTelemetryConfig({
      runDir,
      runId,
      resolvedConfig,
      capturedAt,
    });

    expect(target).toBe(path.join(runDir, 'telemetry', 'config.json'));

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;

    const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
    const validate = ajv.compile(telemetryConfigV1);
    const ok = validate(parsed);
    if (!ok) {
      // Surface the ajv errors when validation fails so a regression names
      // the field that drifted rather than just "validation: false".
      throw new Error(`telemetryConfigV1 validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it('embeds the supplied runId and capturedAt verbatim in the envelope', async () => {
    const runDir = makeRunDir();
    const runId = '20260606T181500-bbbb';
    const capturedAt = '2026-06-06T18:15:00.500Z';

    const target = await writeTelemetryConfig({
      runDir,
      runId,
      resolvedConfig: fabricatedResolvedConfig(),
      capturedAt,
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      envelope: { schemaVersion: number; runId: string; capturedAt: string };
    };

    expect(parsed.envelope.schemaVersion).toBe(1);
    expect(parsed.envelope.runId).toBe(runId);
    expect(parsed.envelope.capturedAt).toBe(capturedAt);
  });

  it('round-trips all ten resolvedConfig required fields', async () => {
    const runDir = makeRunDir();
    const target = await writeTelemetryConfig({
      runDir,
      runId: '20260606T182000-cccc',
      resolvedConfig: fabricatedResolvedConfig(),
      capturedAt: '2026-06-06T18:20:00.250Z',
    });

    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      resolvedConfig: Record<string, unknown>;
    };

    // Pin the ten keys explicitly so a writer regression that drops one
    // (e.g. a refactor that recasts the input through a narrower type) is
    // caught even before the schema validator weighs in.
    for (const key of [
      'apiVersion',
      'schemaVersions',
      'runtimeMode',
      'stacks',
      'overlay',
      'discarded',
      'additionalContext',
      'issues',
      'warnings',
      'modules',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(parsed.resolvedConfig, key)).toBe(true);
    }
  });
});
