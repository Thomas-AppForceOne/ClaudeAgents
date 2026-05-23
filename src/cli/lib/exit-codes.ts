

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

  ApiUnreachable: EXIT_API_UNREACHABLE,

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

export function exitCodeFor(errorCode: string | undefined): number {
  if (errorCode === undefined) return EXIT_OK;
  if (Object.prototype.hasOwnProperty.call(TABLE, errorCode)) {
    return TABLE[errorCode]!;
  }
  return EXIT_GENERIC;
}

export interface IssueLike {
  code: string;
  severity?: 'error' | 'warning';
}

export function exitCodeForIssues(issues: readonly IssueLike[]): number {
  const errors = issues.filter((i) => (i.severity ?? 'error') === 'error');
  if (errors.length === 0) return EXIT_OK;
  if (errors.some((i) => i.code === 'InvariantViolation')) return EXIT_INVARIANT_VIOLATION;
  return EXIT_VALIDATION;
}
