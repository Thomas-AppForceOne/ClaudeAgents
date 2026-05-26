/**
 * The config-server's single non-aborting warning vocabulary.
 *
 * A warning describes an overlay declaration the framework accepted as valid
 * but whose effect diverges from the user's apparent intent — the input parsed
 * cleanly, so it is not a {@link ConfigServerError} (errors abort; warnings do
 * not), but the framework had enough information to flag a likely mistake and
 * chose to surface it rather than stay silent.
 *
 * This is a deliberate sibling to the error catalog in {@link ./errors.ts},
 * built to the same proven shape (a PascalCase code union, a payload interface,
 * an exhaustively-keyed default-message record, and a `create*` factory) but a
 * separate vocabulary: callers branch on `code` (never on message text, which
 * is human-facing and may change), and the codes are the machine contract.
 *
 * Shared guarantee: a `Warning` is a plain JSON-serialisable object (no class,
 * no methods, no live `Error` plumbing), because warnings are carried verbatim
 * inside the resolved-config snapshot, which is serialised to a byte-stable
 * canonical form. Keeping warnings as inert data is what lets the snapshot stay
 * deterministic and lets downstream surfaces render them without recomputation.
 */

/**
 * Closed set of machine-readable warning codes. This union is the stable
 * contract structured consumers (and the test suite) switch on; messages are
 * advisory. Adding a code requires a matching default message in
 * {@link DEFAULT_WARNING_MESSAGES} and a discriminated payload arm in
 * {@link WarningDetails}, both keyed exhaustively by this type — so the
 * compiler refuses to let a new code ship without its message and payload.
 */
export type WarningCode = 'StackOverrideShrinkage' | 'PerStackOverrideUnsupported';

/**
 * Payload carried by a {@link Warning}, discriminated by the warning's `code`.
 *
 * The two arms are disjoint by design so a consumer that has narrowed on `code`
 * gets a precisely-typed `details` with no optional-everything soup. The shapes
 * are intentionally minimal: only the data a surface needs to render the
 * warning or that a structured consumer asserts on.
 *
 * `StackOverrideShrinkage` payload:
 * @property overrideSet the active stack names the user's `stack.override`
 *   produced (locale-sorted for byte-stable output).
 * @property detectionSet the stack names auto-detection would have produced had
 *   the override been absent (locale-sorted).
 * @property suppressed the names present in `detectionSet` but absent from
 *   `overrideSet` — the coverage the override silently dropped (locale-sorted).
 *
 * `PerStackOverrideUnsupported` payload:
 * @property stack the stack name whose per-stack command override was declared.
 * @property fields the overridden command-field names for that stack, collapsed
 *   into one warning and deterministically ordered. The override *values* are
 *   deliberately NOT carried here: a value is opaque user text that may embed a
 *   secret, so only field names are surfaced (see {@link WARNING_FIELD_ORDER}).
 */
export type WarningDetails =
  | {
      code: 'StackOverrideShrinkage';
      overrideSet: string[];
      detectionSet: string[];
      suppressed: string[];
    }
  | {
      code: 'PerStackOverrideUnsupported';
      stack: string;
      fields: string[];
    };

/**
 * One non-aborting warning attached to the resolved-config snapshot.
 *
 * @property code the machine-readable {@link WarningCode}; the contract.
 * @property message human-facing prose for display. Names the user's exact
 *   overlay declaration, explains what was accepted and what it actually did,
 *   and states the remediation. Advisory, not a contract — do not parse it.
 * @property details the code-discriminated {@link WarningDetails} payload.
 */
export interface Warning {
  code: WarningCode;
  message: string;
  details: WarningDetails;
}

/**
 * Fallback human-facing message per code, used when a call site does not supply
 * its own (richer) prose. Keyed by the full {@link WarningCode} union, so adding
 * a code is a compile error here until a default is written — keeping the codes
 * and their messages in lockstep, exactly as the error catalog does.
 *
 * These defaults are intentionally generic: the detection sites build the
 * teaching prose (which names the user's actual sets/fields) and pass it as the
 * explicit message. A default only covers a warning created without one.
 */
const DEFAULT_WARNING_MESSAGES: Record<WarningCode, string> = {
  StackOverrideShrinkage:
    "Your overlay's stack.override is smaller than the framework's auto-detection result, so some stacks auto-detection would have activated are suppressed. stack.override replaces detection wholesale; list every stack you want active to keep them.",
  PerStackOverrideUnsupported:
    'Your overlay declares per-stack command overrides. The framework accepts these in the overlay schema but does not yet apply them, so the override is recorded but does not affect this run. Remove the override to run with the stack-file defaults only.',
};

/**
 * Canonical ordering for the command-override field names a single
 * {@link PerStackOverrideUnsupported} warning may carry. The detection collapses
 * every overridden field for one stack into a single warning, and the snapshot
 * is byte-stable, so the field set must be emitted in a fixed order rather than
 * in user-declaration or hash order. This array is that order; the scan sorts a
 * stack's fields by their index here so two runs over the same overlay produce
 * identical bytes.
 */
export const WARNING_FIELD_ORDER: readonly string[] = [
  'auditCmd',
  'buildCmd',
  'testCmd',
  'lintCmd',
];

/**
 * Canonical factory for a {@link Warning}. Prefer this over building the object
 * literal by hand so the default-message fallback is applied consistently.
 *
 * @param details the code-discriminated {@link WarningDetails} payload; its
 *   `code` selects both the resulting warning's code and (when no explicit
 *   message is given) the default message.
 * @param message optional human-facing prose overriding the per-code default.
 *   Detection sites pass the rich, user-specific prose here; omit it only for a
 *   bare warning that just needs the generic default.
 * @returns a plain, JSON-serialisable {@link Warning}. Never throws and has no
 *   side effects: it neither reads nor logs the caller's data, so it cannot leak
 *   an override value the caller did not put into `details`.
 *
 * Invariant the caller must uphold: `details` must never embed a per-stack
 * override *value* (only field names) — the factory copies `details` through
 * verbatim, so a value placed there would reach the persisted snapshot. The
 * detection layer enforces this by constructing `details` from field names only.
 */
export function createWarning(details: WarningDetails, message?: string): Warning {
  return {
    code: details.code,
    message: message ?? DEFAULT_WARNING_MESSAGES[details.code],
    details,
  };
}
