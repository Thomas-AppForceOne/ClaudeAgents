/**
 * Schema-shape coverage for the three E8 fixture manifests under
 * `tests/fixtures/e8/`.
 *
 * The fixtures themselves are inert source files; the manifests are the
 * machine-readable expectation that downstream framework agents (independent
 * reviewer, contract-proposer, contract-reviewer, evaluator) consume. Without
 * a structural check the fixtures could silently drift — a missing severity,
 * an unrecognised kind, or fewer planted defects than the calibrated suite
 * needs — and the discriminator-quality benchmark would quietly weaken. This
 * suite locks in the shape so any future edit that breaks the contract fails
 * loudly at test time rather than producing misleading reviewer scores.
 *
 * The assertions count entries (≥ 8 defects, ≥ 2 decoys per kind) and check
 * class-set membership rather than performing deep structural validation —
 * keeping fixture authoring lightweight is intentional, since the per-defect
 * source files carry their own JSDoc that documents intent in prose.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse a JSON file relative to {@link THIS_DIR}.
 *
 * Centralised so a mistyped fixture path surfaces as a single readable
 * `ENOENT` rather than as a stack from inside a test body.
 *
 * @param relPath path relative to `tests/fixtures/e8/`.
 * @returns the parsed JSON value (object, array, or primitive).
 */
function loadJson(relPath: string): unknown {
  const abs = path.join(THIS_DIR, relPath);
  return JSON.parse(readFileSync(abs, 'utf8')) as unknown;
}

// The four-class minimum is set so a calibrated suite cannot trivially satisfy
// itself by stacking eight near-identical defects of one kind. The set below
// is the spec's enumeration of classes the suite may draw from.
const ALLOWED_CLASSES = new Set([
  'correctness',
  'security',
  'concurrency',
  'error-handling',
  'regression',
]);
const MIN_DISTINCT_CLASSES = 4;
const MIN_DEFECTS = 8;
const MIN_DECOYS_PER_KIND = 2;

describe('E8 single-defect fixture manifest matches the fail-as-rejection contract', () => {
  it('parses as valid JSON and declares severity blocker with kind command or inspection', () => {
    const m = loadJson('single-defect/manifest.json') as Record<string, unknown>;
    // severity MUST be blocker — the fixture is the acceptance case for the
    // "blocker auto-fail" gate the proposer enforces.
    expect(m.severity).toBe('blocker');
    expect(['command', 'inspection']).toContain(m.kind);
    // expected_finding_kind mirrors `kind` for downstream consumers that read
    // the snake_case field. Both must be present.
    expect(['command', 'inspection']).toContain(m.expected_finding_kind);
    // The fixture's whole purpose is to demonstrate the fail-as-rejection
    // terminal outcome; any other gate value is a regression.
    expect(m.expected_gate_behaviour).toBe('fail-as-rejection');
    expect(typeof m.defect_class).toBe('string');
  });
});

describe('E8 planted-defects calibrated suite hits the minimum size and class spread', () => {
  it('enumerates at least 8 defects spanning at least 4 classes drawn from the allowed set', () => {
    const entries = loadJson('planted-defects/manifest.json') as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    // The 8/4 bar is the discriminator-quality floor: with fewer than 8 the
    // reviewer-catch-rate metric is statistically meaningless, and with
    // fewer than 4 classes the suite cannot detect a reviewer that is good
    // at one class but blind to another.
    expect(entries.length).toBeGreaterThanOrEqual(MIN_DEFECTS);
    const classes = new Set(entries.map((e) => e.class as string));
    for (const c of classes) {
      expect(ALLOWED_CLASSES).toContain(c);
    }
    expect(classes.size).toBeGreaterThanOrEqual(MIN_DISTINCT_CLASSES);
  });

  it('every entry carries the required fields with a recognised kind', () => {
    const entries = loadJson('planted-defects/manifest.json') as Array<Record<string, unknown>>;
    for (const e of entries) {
      // id is the subdirectory name on disk; missing id means a fixture
      // without a backing source tree, which the discriminator cannot
      // exercise.
      expect(typeof e.id).toBe('string');
      expect(typeof e.class).toBe('string');
      expect(typeof e.severity).toBe('string');
      expect(['command', 'inspection']).toContain(e.kind);
      expect(typeof e.description).toBe('string');
      expect(typeof e.expected_catch_behaviour).toBe('string');
    }
  });
});

describe('E8 unfounded-finding decoy suite carries enough decoys of each kind', () => {
  it('enumerates at least 2 command decoys and at least 2 inspection decoys', () => {
    const entries = loadJson('decoys/manifest.json') as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    const commandCount = entries.filter((e) => e.kind === 'command').length;
    const inspectionCount = entries.filter((e) => e.kind === 'inspection').length;
    // Two of each kind exercises the two distinct guard paths: command
    // decoys drop at the reproduction-gate; inspection decoys reject at the
    // well-foundedness audit. Fewer than 2 per kind cannot tell a reviewer
    // that is robust on one path but blind on the other.
    expect(commandCount).toBeGreaterThanOrEqual(MIN_DECOYS_PER_KIND);
    expect(inspectionCount).toBeGreaterThanOrEqual(MIN_DECOYS_PER_KIND);
  });

  it('command decoys carry a reproductionCommand and inspection decoys carry an evidencePointer', () => {
    const entries = loadJson('decoys/manifest.json') as Array<Record<string, unknown>>;
    for (const e of entries) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.expectedDropOrReject).toBe('string');
      const payload = e.fakedFindingPayload as Record<string, unknown> | undefined;
      expect(payload).toBeDefined();
      if (e.kind === 'command') {
        // The reproduction-gate only sees the reproductionCommand; without
        // it the decoy cannot be exercised at all.
        expect(typeof payload?.reproductionCommand).toBe('string');
      } else {
        // The well-foundedness audit opens evidencePointer to verify the
        // cited code; missing pointer makes the decoy untestable.
        expect(typeof payload?.evidencePointer).toBe('string');
      }
    }
  });
});
