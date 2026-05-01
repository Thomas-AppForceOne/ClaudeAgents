/**
 * R3 sprint 1 — F2 error code → CLI exit code map.
 *
 * The map is locked in PROJECT_CONTEXT.md (R3-locked CLI exit-code map):
 *
 *   0    success
 *   1    generic failure
 *   2    validation failure (config issues; structured report on stdout)
 *   3    SchemaMismatch
 *   4    InvariantViolation
 *   5    API/server unreachable (R1 dependency missing or unreadable)
 *   64   bad CLI arguments
 *
 * Per the project conventions, unmapped error codes default to 1 (generic
 * failure) so a future F2 error never accidentally surfaces as 0.
 */

export const EXIT_OK = 0;
export const EXIT_GENERIC = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_SCHEMA_MISMATCH = 3;
export const EXIT_INVARIANT_VIOLATION = 4;
export const EXIT_API_UNREACHABLE = 5;
export const EXIT_BAD_ARGS = 64;

const TABLE: Readonly<Record<string, number>> = Object.freeze({
  ValidationFailed: EXIT_VALIDATION,
  SchemaMismatch: EXIT_SCHEMA_MISMATCH,
  InvariantViolation: EXIT_INVARIANT_VIOLATION,
  // API unreachable / library missing. R1 surfaces this as a thrown error
  // when its package.json cannot be read; the dispatcher maps it here.
  ApiUnreachable: EXIT_API_UNREACHABLE,
  // F2-cataloged codes that map to known buckets.
  CacheEnvConflict: EXIT_INVARIANT_VIOLATION,
  PathEscape: EXIT_INVARIANT_VIOLATION,
  UnknownStack: EXIT_VALIDATION,
  UnknownSplicePoint: EXIT_VALIDATION,
  UntrustedOverlay: EXIT_VALIDATION,
  TrustCacheCorrupt: EXIT_GENERIC,
  InvalidYAML: EXIT_VALIDATION,
  MissingFile: EXIT_VALIDATION,
  UnknownApiVersion: EXIT_GENERIC,
  NotImplemented: EXIT_GENERIC,
  MalformedInput: EXIT_BAD_ARGS,
});

/**
 * Return the exit code for a given F2 error code (or `undefined` for "no
 * error → 0"). Unknown codes return `EXIT_GENERIC` per the locked rule.
 */
export function exitCodeFor(errorCode: string | undefined): number {
  if (errorCode === undefined) return EXIT_OK;
  if (Object.prototype.hasOwnProperty.call(TABLE, errorCode)) {
    return TABLE[errorCode]!;
  }
  return EXIT_GENERIC;
}
