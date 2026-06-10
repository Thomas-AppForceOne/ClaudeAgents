/**
 * Bundling-invariant test for `schemas/evaluator-evidence-bundle-v2.json` (T5).
 *
 * Two assertions:
 *   1. The bundled-schemas module exports `evaluatorEvidenceBundleV2` with the
 *      canonical `$id` so a runtime consumer can identify it.
 *   2. The bundled copy is deep-equal to the on-disk schema — the standard
 *      parity check that catches drift between the two (an edit to the JSON
 *      file without a re-import, or vice versa).
 *
 * Mirrors the analogous tests for `independent-review-v1`, `progress-v1`,
 * and the telemetry schemas so the published-schema set is fully covered by
 * a single, uniform parity gate.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatorEvidenceBundleV2 } from '../../src/config-server/schemas-bundled.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const schemaPath = path.join(repoRoot, 'schemas', 'evaluator-evidence-bundle-v2.json');

describe('schemas-bundled — evaluator-evidence-bundle-v2', () => {
  it('exports evaluatorEvidenceBundleV2 with the canonical $id', () => {
    expect(evaluatorEvidenceBundleV2).toBeDefined();
    expect((evaluatorEvidenceBundleV2 as { $id?: string }).$id).toBe(
      'https://claudeagents.dev/schemas/evaluator-evidence-bundle-v2.json',
    );
  });

  it('the bundled copy deep-equals the on-disk schema', () => {
    const onDiskRaw = readFileSync(schemaPath, 'utf8');
    const onDisk = JSON.parse(onDiskRaw) as Record<string, unknown>;
    expect(evaluatorEvidenceBundleV2).toEqual(onDisk);
  });

  it('declares additionalProperties: false at the top level', () => {
    expect((evaluatorEvidenceBundleV2 as { additionalProperties?: unknown }).additionalProperties).toBe(
      false,
    );
  });

  it('declares evaluatorPromptDigest as a required root field with the SHA-256 hex pattern', () => {
    const schema = evaluatorEvidenceBundleV2 as {
      required?: string[];
      properties?: { evaluatorPromptDigest?: { pattern?: string; type?: string } };
    };
    expect(schema.required).toContain('evaluatorPromptDigest');
    expect(schema.properties?.evaluatorPromptDigest?.type).toBe('string');
    expect(schema.properties?.evaluatorPromptDigest?.pattern).toBe('^[0-9a-f]{64}$');
  });
});
