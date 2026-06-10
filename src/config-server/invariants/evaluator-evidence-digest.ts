/**
 * Consumer-side invariant for the evaluator-evidence-bundle digest (T5).
 *
 * The v2 bundle schema requires every evidence bundle to carry an
 * `evaluatorPromptDigest` root field — the SHA-256 hex digest of
 * `agents/gan-evaluator.md` stamped by the orchestrator at evaluator spawn.
 * The schema check (ajv) catches a missing or malformed digest at the bundle
 * verification gate; this module is the defence-in-depth assertion: every
 * code path that consumes a bundle and trusts its verdicts must call this
 * function first, so a v1-shaped (no-digest) bundle slipping past a legacy
 * code path is rejected by an additional, focused check rather than silently
 * accepted.
 *
 * The function is dual-callable per R1: the {@link assertEvaluatorEvidenceDigest}
 * is the single implementation; any wrapper or tool surface delegates here.
 */

/**
 * Result of a digest assertion against a bundle.
 *
 * The result is returned as data — never thrown — so a caller can choose
 * between a hard reject (treat any non-ok result as a programming-tier fault)
 * and a soft surface (log the structured failure and reject the bundle in the
 * higher-level error vocabulary). The `code` discriminates the failure modes
 * so a downstream handler can match without parsing prose.
 *
 * @property ok `true` iff every check passes (the bundle is an object, the
 *   digest field is present, the digest is a 64-character lowercase hex
 *   string). `false` on any failure.
 * @property code stable machine code on failure; absent on success. Values:
 *   `'MissingDigest'` (the field is absent), `'MalformedDigest'` (the field
 *   exists but is not a 64-hex string), `'BundleNotObject'` (the bundle is not
 *   an object — caller is misusing the invariant). A consumer can route on this
 *   code without inspecting `message`.
 * @property message human-readable description of the failure; absent on
 *   success. Stable enough for tests to assert on prefix but worded for a
 *   developer reading a structured-error surface, not paraphrased by callers.
 */
export interface EvaluatorEvidenceDigestResult {
  ok: boolean;
  code?: 'MissingDigest' | 'MalformedDigest' | 'BundleNotObject';
  message?: string;
}

// The required digest shape (lowercase SHA-256 hex, 64 characters) — pinned in
// the v2 schema as `pattern: "^[0-9a-f]{64}$"` and re-pinned here so this
// invariant fires the same way ajv would even when the schema validator was
// skipped by a legacy code path. Two homes are intentional: the schema is the
// boundary at validation time, this module is the boundary at consumption time.
const SHA256_HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Assert that an evaluator-evidence bundle carries a well-formed
 * `evaluatorPromptDigest`.
 *
 * The function is pure: it inspects the supplied value as data and returns a
 * structured {@link EvaluatorEvidenceDigestResult}. It does not read the
 * filesystem, does not consult the schema-bundled validator, and does not
 * throw on a bundle-shape problem — every detected fault is returned as data
 * so the caller chooses how to escalate (e.g. converting a `MissingDigest`
 * result into a `SchemaMismatch` issue in `validateAll`, or into a non-zero
 * exit in a CLI consumer).
 *
 * Why the call site matters: an evidence bundle may reach a consumer through
 * any of three legacy paths (a recovered v1 file on disk that pre-dates the
 * v2 bump, a hand-edited bundle from a debugging workflow, or a future
 * orchestrator regression that skips the digest stamp). Each of those paths
 * would defeat the audit-trail purpose of the digest if the consumer trusted
 * the bundle without re-checking. This invariant is the second gate.
 *
 * @param bundle the evidence bundle to inspect. The function accepts
 *   `unknown` rather than a typed shape so callers can hand it the raw parsed
 *   JSON before any narrowing; an unknown value that is not an object yields
 *   `code: 'BundleNotObject'`.
 * @returns the {@link EvaluatorEvidenceDigestResult}. The caller upholds the
 *   convention that any non-ok result is treated as a rejection of the bundle.
 *
 * Failure modes (caller-visible):
 * - `BundleNotObject` — the supplied value is not a plain object (a null, an
 *   array, or a primitive); a usage fault on the caller's part.
 * - `MissingDigest` — the bundle is an object but does not carry the
 *   `evaluatorPromptDigest` property.
 * - `MalformedDigest` — the property exists but is not a 64-character
 *   lowercase hex string.
 */
export function assertEvaluatorEvidenceDigest(bundle: unknown): EvaluatorEvidenceDigestResult {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return {
      ok: false,
      code: 'BundleNotObject',
      message:
        'evaluator-evidence-bundle digest check refused: the supplied value is not a JSON object.',
    };
  }

  // Property access on a known-object value; the cast narrows for the digest
  // read without copying the bundle.
  const obj = bundle as Record<string, unknown>;
  const raw = obj['evaluatorPromptDigest'];
  if (raw === undefined) {
    return {
      ok: false,
      code: 'MissingDigest',
      message:
        "evaluator-evidence-bundle is missing the required 'evaluatorPromptDigest' field. " +
        'The orchestrator stamps this field at evaluator spawn with the lowercase SHA-256 ' +
        "hex digest of agents/gan-evaluator.md; a bundle without it is a v1-shaped legacy " +
        "artefact and is not trusted by the v2 read path.",
    };
  }

  if (typeof raw !== 'string' || !SHA256_HEX_64.test(raw)) {
    return {
      ok: false,
      code: 'MalformedDigest',
      message:
        "evaluator-evidence-bundle 'evaluatorPromptDigest' is not a 64-character lowercase " +
        'hex string. The orchestrator must stamp a SHA-256 hex digest (^[0-9a-f]{64}$) of ' +
        'agents/gan-evaluator.md; any other value is refused.',
    };
  }

  return { ok: true };
}
