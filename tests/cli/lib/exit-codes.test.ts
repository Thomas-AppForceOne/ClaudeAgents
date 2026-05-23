// Table-driven pin of `exitCodeFor`: the function that maps a config-server
// error code (or absence of one) to the process exit code the CLI returns.
// These numbers are a stable contract scripts and CI depend on, so each row is
// locked here. The grouping under test: validation-class errors share exit 2,
// invariant violations share 4, malformed CLI input is the conventional 64
// (EX_USAGE), and anything unmapped — including codes that don't exist yet —
// must fall back to the generic 1 rather than throwing or returning undefined.

import { describe, expect, it } from 'vitest';
import {
  exitCodeFor,
  EXIT_LOOP_DETECTED,
  EXIT_VALIDATION,
  EXIT_SCHEMA_MISMATCH,
  EXIT_INVARIANT_VIOLATION,
  EXIT_API_UNREACHABLE,
  EXIT_BAD_ARGS,
} from '../../../src/cli/lib/exit-codes.js';

// One row per error code → expected exit code, with the rationale that pins it.
// `code: undefined` models "no error"; `TotallyUnknownFutureCode` deliberately
// exercises the unmapped-code fallback so future codes can't silently regress.
const TABLE: Array<{ code: string | undefined; expected: number; reason: string }> = [
  { code: undefined, expected: 0, reason: 'no error → success' },
  { code: 'ValidationFailed', expected: 2, reason: 'validation failure' },
  { code: 'SchemaMismatch', expected: 3, reason: 'schema mismatch' },
  { code: 'InvariantViolation', expected: 4, reason: 'invariant violation' },
  { code: 'ApiUnreachable', expected: 5, reason: 'API unreachable' },
  { code: 'CacheEnvConflict', expected: 4, reason: 'cache-env conflict is an invariant' },
  { code: 'PathEscape', expected: 4, reason: 'path-escape is an invariant' },
  { code: 'UnknownStack', expected: 2, reason: 'unknown stack is a validation failure' },
  {
    code: 'UnknownSplicePoint',
    expected: 2,
    reason: 'unknown splice point is a validation failure',
  },
  {
    code: 'UntrustedOverlay',
    expected: 2,
    reason: 'untrusted overlay surfaces as validation failure',
  },
  { code: 'TrustCacheCorrupt', expected: 1, reason: 'corrupt trust cache → generic' },
  { code: 'InvalidYAML', expected: 2, reason: 'invalid YAML is a validation failure' },
  { code: 'MissingFile', expected: 2, reason: 'missing file is a validation failure' },
  { code: 'UnknownApiVersion', expected: 1, reason: 'unknown API version → generic' },
  { code: 'NotImplemented', expected: 1, reason: 'not-yet-implemented → generic' },
  { code: 'MalformedInput', expected: 64, reason: 'malformed CLI input → bad args' },
  {
    code: 'LoopDetected',
    expected: 6,
    reason: 'A1 loop-detection halt → its own exit class, distinct from validation',
  },
  { code: 'TotallyUnknownFutureCode', expected: 1, reason: 'unmapped code defaults to generic' },
];

describe('exitCodeFor', () => {
  for (const row of TABLE) {
    it(`maps ${row.code ?? '(undefined)'} → ${row.expected} (${row.reason})`, () => {
      expect(exitCodeFor(row.code)).toBe(row.expected);
    });
  }
});

describe('loop_detected_exit_code_is_distinct_from_validation_classes', () => {
  it('exitCodeFor("LoopDetected") returns the EXIT_LOOP_DETECTED constant', () => {
    expect(exitCodeFor('LoopDetected')).toBe(EXIT_LOOP_DETECTED);
  });

  it('EXIT_LOOP_DETECTED is non-zero and distinct from every validation-class code', () => {
    expect(EXIT_LOOP_DETECTED).not.toBe(0);
    for (const other of [
      EXIT_VALIDATION,
      EXIT_SCHEMA_MISMATCH,
      EXIT_INVARIANT_VIOLATION,
      EXIT_API_UNREACHABLE,
      EXIT_BAD_ARGS,
    ]) {
      expect(EXIT_LOOP_DETECTED).not.toBe(other);
    }
  });
});
