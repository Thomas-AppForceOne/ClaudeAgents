// Schema-conformance tests for the Q5 documentation fields added to the
// stack-v1 schema: `documentationSurfaces` (the doc-quality triggers a stack
// declares) and `docLintCmd` (how to invoke a documentation linter). The
// FUNC-N labels track the Q5 spec's functional requirements.
//
// The contracts under test:
//  - FUNC-1: both fields are ADDITIVE and OPTIONAL — an existing stack omitting
//    them still validates, and either may appear without the other. This is the
//    backward-compatibility guarantee for stacks written before Q5.
//  - FUNC-2: a documentationSurfaces entry requires both `id` and `template`,
//    supports the two trigger forms (scope-only, and scope+keywords), and is a
//    closed object (an unknown item property is rejected).
//  - FUNC-3/FUNC-4: docLintCmd has a conditional shape keyed on `absenceSignal`.
//    The "silent" branch may omit `absenceMessage`; the "warning" and
//    "blockingConcern" branches REQUIRE it. `severity` and `baseline` are
//    enum-constrained, and `command` has minLength 1.
//
// `schemaMismatches` filters to only SchemaMismatch issues so a test asserts on
// the schema verdict alone, ignoring any unrelated issue codes. STACK_PATH is a
// throwaway label for the issues.
import { describe, expect, it } from 'vitest';

import {
  validateStackBodyAgainstSchema,
  type Issue,
} from '../../src/config-server/validation/schema-check.js';

const STACK_PATH = '/tmp/q5-stack.md';

// Validate a stack body (with a valid schemaVersion supplied) and keep only the
// schema-conformance issues, so each test reasons about SchemaMismatch alone.
function schemaMismatches(body: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  validateStackBodyAgainstSchema(STACK_PATH, { schemaVersion: 1, ...body }, issues);
  return issues.filter((i) => i.code === 'SchemaMismatch');
}

describe('Q5 stack schema — additive optional fields', () => {
  it('FUNC-1: a body omitting both Q5 fields still validates', () => {

    // A pre-Q5-shaped stack (scope/buildCmd/securitySurfaces, no doc fields)
    // must still pass — the additive fields cannot regress older stacks.
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
    // Only the `silent` branch may omit absenceMessage; the warning /
    // blockingConcern branches require it (asserted in FUNC-4 below). This is
    // the positive half of that conditional-shape rule.
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
    // The negative half of the conditional-shape rule: a non-silent signal
    // without an absenceMessage is invalid (there would be nothing to surface).
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
