

/**
 * The CLI's process-exit-code vocabulary and the mapping from internal error
 * codes to it.
 *
 * Exit codes are part of the CLI's contract with scripts and CI, so the set is
 * fixed and meaningful: callers branch on them without parsing output. This
 * module owns the numeric constants and the single translation table from a
 * `ConfigServerError.code` (a string) to the exit code it should produce, so
 * every command surfaces the same failure as the same code.
 *
 * The values follow convention: 0 success, 1 generic, 2–6 specific failure
 * classes, and 64 (`EX_USAGE` from sysexits) for bad CLI arguments.
 */

export const EXIT_OK = 0;
export const EXIT_GENERIC = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_SCHEMA_MISMATCH = 3;
export const EXIT_INVARIANT_VIOLATION = 4;
export const EXIT_API_UNREACHABLE = 5;

/**
 * Loop/thrash safety halt (`LoopDetected`). Deliberately its own class,
 * distinct from the validation codes (2–5): a halt means "the work could not
 * converge", not "the configuration or contract was malformed", and scripts/CI
 * must be able to tell the two apart without parsing output. Placed at 6 as the
 * next free specific-failure slot above the validation classes and below the
 * sysexits usage code (64).
 */
export const EXIT_LOOP_DETECTED = 6;

export const EXIT_BAD_ARGS = 64;

// Maps each known internal error code to its exit code. Several distinct error
// codes intentionally collapse onto one exit code (e.g. PathEscape and
// CacheEnvConflict both surface as EXIT_INVARIANT_VIOLATION): the exit code
// classifies the *kind* of failure for scripts, while the error code carries
// the specific reason in the printed/JSON payload. Frozen so it cannot be
// mutated at runtime, and module-private — exitCodeFor is the only reader.
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
  InvalidTimeoutValue: EXIT_VALIDATION,
  UnknownApiVersion: EXIT_GENERIC,
  NotImplemented: EXIT_GENERIC,
  MalformedInput: EXIT_BAD_ARGS,

  // A loop-detection halt is its own exit class so a caller can distinguish
  // "the framework halted an unproductive loop" from a contract/validation
  // failure, which it would otherwise be conflated with.
  LoopDetected: EXIT_LOOP_DETECTED,

  // `gan hooks migrate` structured-error code registry. Every failure
  // path in the migrate command routes through `migrateError(...)` and
  // emits one of these `code` tokens on stderr; registering them here
  // makes `exitCodeFor` resolve the same exit value uniformly when a
  // ConfigServerError or other propagated error carries one of the
  // codes. The grouping matches the migrate command's exit-code split:
  // bad-args / validation / generic.
  GanHooksMigrateActionRequired: EXIT_BAD_ARGS,
  GanHooksMigrateActionConflict: EXIT_BAD_ARGS,
  GanHooksMigrateInvalidProjectRoot: EXIT_BAD_ARGS,
  GanHooksMigrateConfirmationRequired: EXIT_VALIDATION,
  GanHooksMigrateCancelled: EXIT_VALIDATION,
  GanHooksMigrateProjectHookIsSymlink: EXIT_VALIDATION,
  GanHooksMigrateSourceReadFailed: EXIT_GENERIC,
  GanHooksMigrateTemplateError: EXIT_GENERIC,
  GanHooksMigrateFilesystemError: EXIT_GENERIC,

  // `gan hooks status` structured-error codes. Currently just the
  // one argument-error path. Same `Gan<Command><Specific>` shape as
  // the `GanHooksMigrate*` family above; the prefix scopes the
  // token to the emitting command so future structured-error
  // commands extend the registry without collision.
  GanHooksStatusInvalidProjectRoot: EXIT_BAD_ARGS,
});

/**
 * Translate an internal error code into the process exit code to return.
 *
 * @param errorCode a `ConfigServerError.code` string, or `undefined` for the
 *   no-error case.
 * @returns `EXIT_OK` when `errorCode` is `undefined`; the mapped code when the
 *   code is in {@link TABLE}; otherwise `EXIT_GENERIC` — an unrecognised code
 *   is deliberately treated as a generic failure rather than thrown, so a new
 *   or unmapped error never crashes the dispatcher. `hasOwnProperty` is used
 *   (not `in`) so a code colliding with an inherited `Object` property name
 *   cannot accidentally match.
 */
export function exitCodeFor(errorCode: string | undefined): number {
  if (errorCode === undefined) return EXIT_OK;
  if (Object.prototype.hasOwnProperty.call(TABLE, errorCode)) {
    return TABLE[errorCode]!;
  }
  return EXIT_GENERIC;
}

/**
 * Minimal shape of a validation issue this module needs to classify it.
 *
 * @property code the issue's error code (e.g. `InvariantViolation`).
 * @property severity `error` or `warning`; when omitted it is treated as
 *   `error` (the conservative default — see {@link exitCodeForIssues}).
 */
export interface IssueLike {
  code: string;
  severity?: 'error' | 'warning';
}

/**
 * Reduce a list of validation issues to a single exit code.
 *
 * Only `error`-severity issues affect the result; `warning`s never fail the
 * process. An absent `severity` is treated as `error`.
 *
 * @param issues the issues produced by a validation run.
 * @returns `EXIT_OK` when there are no error-severity issues; otherwise
 *   `EXIT_INVARIANT_VIOLATION` if any error is an `InvariantViolation` (the
 *   more severe class is reported when both are present), else
 *   `EXIT_VALIDATION`.
 */
export function exitCodeForIssues(issues: readonly IssueLike[]): number {
  const errors = issues.filter((i) => (i.severity ?? 'error') === 'error');
  if (errors.length === 0) return EXIT_OK;
  if (errors.some((i) => i.code === 'InvariantViolation')) return EXIT_INVARIANT_VIOLATION;
  return EXIT_VALIDATION;
}
