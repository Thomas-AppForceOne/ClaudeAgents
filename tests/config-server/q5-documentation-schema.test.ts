/**
 * Q5 Sprint 1 — body-schema validation tests for the two additive optional
 * stack fields `documentationSurfaces` and `docLintCmd`.
 *
 * The fields are exercised through the SAME ajv body-validation path the
 * `lint-stacks` script delegates to (`validateStackBodyAgainstSchema` in
 * `validation/schema-check.ts`, compiled under the pinned `strict: true`,
 * `allErrors: true`, `useDefaults: false` options) — not a parallel ajv
 * configuration. Per Q5's Sprint 1 plan the malformed-`docLintCmd` rejection
 * rides this existing path: the constraints are enum/oneOf-expressible, so no
 * bespoke check function is added and the rejection is purely schema-driven.
 *
 * Coverage:
 *   - FUNC-1: a body that omits BOTH fields still validates (additive optional);
 *     declaring either field does not require the other.
 *   - FUNC-2: a well-formed `documentationSurfaces` entry validates; an entry
 *     missing `id` or `template`, or carrying an unknown item property, is
 *     rejected with a `SchemaMismatch` issue.
 *   - FUNC-3: a well-formed `docLintCmd` (both the silent and non-silent
 *     branches, with optional `baseline`/`fallback`) validates.
 *   - FUNC-4: a malformed `docLintCmd` is rejected with a `SchemaMismatch`
 *     issue — (a) a `severity` outside the enum, (b) a missing `absenceMessage`
 *     when `absenceSignal` is not `silent`, (c) a `baseline` outside the enum,
 *     and the related missing-`severity` case.
 */
import { describe, expect, it } from 'vitest';

import {
  validateStackBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';

const STACK_PATH = '/tmp/q5-stack.md';

/**
 * Validate a stack body (the caller supplies the body without the
 * `schemaVersion` frontmatter field; this helper adds the F3-required
 * `schemaVersion: 1` so the body schema, not the version gate, is what is
 * under test) and return only the `SchemaMismatch` issues.
 */
function schemaMismatches(body: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  validateStackBodyAgainstSchema(STACK_PATH, { schemaVersion: 1, ...body }, issues);
  return issues.filter((i) => i.code === 'SchemaMismatch');
}

describe('Q5 stack schema — additive optional fields', () => {
  it('FUNC-1: a body omitting both Q5 fields still validates', () => {
    // Mirrors the shipped `stacks/web-node.md` shape before Q5: command
    // fields + securitySurfaces, no documentationSurfaces / docLintCmd.
    const body = {
      scope: ['**/*.ts'],
      buildCmd: 'npm run build',
      securitySurfaces: [{ id: 'a', template: 't' }],
    };
    expect(schemaMismatches(body)).toEqual([]);
  });

  it('FUNC-1: documentationSurfaces may be declared without docLintCmd', () => {
    const body = {
      documentationSurfaces: [{ id: 'a', template: 't' }],
    };
    expect(schemaMismatches(body)).toEqual([]);
  });

  it('FUNC-1: docLintCmd may be declared without documentationSurfaces', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'warning',
        absenceMessage: 'm',
        severity: 'blocker',
      },
    };
    expect(schemaMismatches(body)).toEqual([]);
  });
});

describe('Q5 stack schema — documentationSurfaces shape (FUNC-2)', () => {
  it('accepts a well-formed entry with both trigger forms', () => {
    const body = {
      documentationSurfaces: [
        {
          id: 'public_contract_completeness',
          template: 'Every exported symbol documents its contract.',
          triggers: {
            scope: ['**/*.ts', '**/*.tsx'],
            keywords: ['export function', 'export class'],
          },
        },
        {
          id: 'comments_explain_why_not_what',
          template: 'Comments explain why, not what.',
          triggers: { scope: ['**/*.ts'] },
        },
      ],
    };
    expect(schemaMismatches(body)).toEqual([]);
  });

  it('rejects an entry missing `template` with a SchemaMismatch issue', () => {
    const body = { documentationSurfaces: [{ id: 'a' }] };
    const issues = schemaMismatches(body);
    expect(issues.length).toBeGreaterThan(0);
    expect(
      issues.some(
        (i) => i.message.includes('template') || (i.field ?? '').includes('documentationSurfaces'),
      ),
    ).toBe(true);
  });

  it('rejects an entry missing `id` with a SchemaMismatch issue', () => {
    const body = { documentationSurfaces: [{ template: 't' }] };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });

  it('rejects an entry carrying an unknown item property', () => {
    const body = { documentationSurfaces: [{ id: 'a', template: 't', bogus: 1 }] };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });
});

describe('Q5 stack schema — docLintCmd shape (FUNC-3)', () => {
  it('accepts the non-silent branch with all required + optional fields', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        fallback: 'doc-lint --fallback',
        absenceSignal: 'warning',
        absenceMessage: 'No documentation linter is configured.',
        severity: 'blocker',
        baseline: 'delta',
      },
    };
    expect(schemaMismatches(body)).toEqual([]);
  });

  it('accepts the non-silent `blockingConcern` branch', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'blockingConcern',
        absenceMessage: 'No documentation linter is configured.',
        severity: 'warning',
        baseline: 'absolute',
      },
    };
    expect(schemaMismatches(body)).toEqual([]);
  });

  it('accepts the silent branch without an absenceMessage', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'silent',
        severity: 'advisory',
      },
    };
    expect(schemaMismatches(body)).toEqual([]);
  });

  it('accepts a docLintCmd that omits the optional baseline (defaults to delta downstream)', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'warning',
        absenceMessage: 'm',
        severity: 'blocker',
      },
    };
    expect(schemaMismatches(body)).toEqual([]);
  });
});

describe('Q5 stack schema — malformed docLintCmd rejected (FUNC-4)', () => {
  it('(a) rejects a severity outside the enum with a SchemaMismatch issue', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'warning',
        absenceMessage: 'm',
        severity: 'critical',
      },
    };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });

  it('(b) rejects a missing absenceMessage when absenceSignal is `warning`', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'warning',
        severity: 'blocker',
      },
    };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });

  it('(b) rejects a missing absenceMessage when absenceSignal is `blockingConcern`', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'blockingConcern',
        severity: 'blocker',
      },
    };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });

  it('(c) rejects a baseline outside the enum with a SchemaMismatch issue', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'warning',
        absenceMessage: 'm',
        severity: 'blocker',
        baseline: 'ratchet',
      },
    };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });

  it('rejects a docLintCmd missing the required severity', () => {
    const body = {
      docLintCmd: {
        command: 'doc-lint',
        absenceSignal: 'warning',
        absenceMessage: 'm',
      },
    };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });

  it('rejects a docLintCmd with an empty `command` (minLength: 1)', () => {
    const body = {
      docLintCmd: {
        command: '',
        absenceSignal: 'warning',
        absenceMessage: 'm',
        severity: 'blocker',
      },
    };
    expect(schemaMismatches(body).length).toBeGreaterThan(0);
  });
});
