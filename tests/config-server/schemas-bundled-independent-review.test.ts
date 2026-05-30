/**
 * Bundling-invariant test for `schemas/independent-review-v1.json`.
 *
 * Two assertions:
 * 1. The bundled-schemas module exports `independentReviewV1` with the
 *    canonical `$id` so a runtime consumer can identify it.
 * 2. The bundled copy is deep-equal to the on-disk schema — a parity
 *    check that catches drift between the two (e.g. a maintainer edits
 *    the JSON file but forgets to rebuild, or vice versa).
 *
 * This is the "publish-schemas invariant" check from the sprint
 * contract: every shipped schema under `schemas/` must be visible from
 * `schemas-bundled.ts` so ajv can compile it at runtime without
 * touching disk.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { independentReviewV1 } from '../../src/config-server/schemas-bundled.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const schemaPath = path.join(repoRoot, 'schemas', 'independent-review-v1.json');

describe('schemas-bundled — independent-review-v1', () => {
  it('exports independentReviewV1 with the canonical $id', () => {
    // Spot-checks the export exists and carries the schema's $id. The
    // exact $id is the URL the runtime uses to identify the schema in
    // ajv's compile cache and in cross-schema $ref, so it is part of
    // the contract.
    expect(independentReviewV1).toBeDefined();
    expect((independentReviewV1 as { $id?: string }).$id).toBe(
      'https://claudeagents.dev/schemas/independent-review-v1.json',
    );
  });

  it('the bundled copy deep-equals the on-disk schema', () => {
    // Catches the drift class where the on-disk JSON is edited but
    // schemas-bundled.ts is not rebuilt (or vice versa). The on-disk
    // file is the canonical source; the bundled copy is the runtime
    // mirror.
    const onDiskRaw = readFileSync(schemaPath, 'utf8');
    const onDisk = JSON.parse(onDiskRaw) as Record<string, unknown>;
    expect(independentReviewV1).toEqual(onDisk);
  });

  it('declares additionalProperties: false at the top level', () => {
    // The strict-additionalProperties rule is what makes a typo'd field
    // a validation error rather than a silent drop, so it is part of the
    // schema's contract and is asserted here in addition to the negative
    // tests in schema-validation.test.ts.
    expect((independentReviewV1 as { additionalProperties?: unknown }).additionalProperties).toBe(
      false,
    );
  });
});
