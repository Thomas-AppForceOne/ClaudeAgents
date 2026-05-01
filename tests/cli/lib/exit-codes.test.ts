/**
 * R3 sprint 1 — F2 error code → exit code mapping.
 *
 * Table-driven: one row per F2 code we currently handle. The default
 * (`undefined`) maps to 0; unknown codes map to 1 (generic) per the
 * locked rule in PROJECT_CONTEXT.md.
 */
import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../../src/cli/lib/exit-codes.js';

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
  { code: 'TotallyUnknownFutureCode', expected: 1, reason: 'unmapped code defaults to generic' },
];

describe('exitCodeFor', () => {
  for (const row of TABLE) {
    it(`maps ${row.code ?? '(undefined)'} → ${row.expected} (${row.reason})`, () => {
      expect(exitCodeFor(row.code)).toBe(row.expected);
    });
  }
});
