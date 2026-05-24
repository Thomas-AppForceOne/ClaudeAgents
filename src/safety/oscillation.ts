/**
 * Edit-oscillation detection — the framework-owned halt primitive for the
 * generator role specifically.
 *
 * Where {@link checkRoleCeiling} caps how many times the generator may attempt
 * its step and {@link checkSprintBudget} caps the combined cross-role work,
 * this module catches a subtler failure: a generator that keeps re-proposing
 * the *same* change (or alternating between two changes) across attempts is not
 * converging even though it has not yet exhausted its attempt ceiling. This is
 * oscillation, and the framework halts it so it does not burn the remaining
 * attempts re-litigating an interpretation the evaluator has already rejected.
 *
 * Like the other two checks, every export here is **pure**: a function over
 * a plain per-attempt history (the fingerprints `fingerprintEditSet`
 * produced, each paired with a boolean reconstructed from the trace) with no
 * I/O and no persisted state. The orchestrator composes it at attempt-start
 * boundaries (see `skills/gan/SKILL.md`); this file owns only the decision.
 *
 * Why this module consumes fingerprints rather than re-deriving them: the
 * digest `fingerprintEditSet` returns already encodes the whole "logically the
 * same change" normalization contract (whitespace/comment/reorder collapsing).
 * Re-hashing here would risk a second, divergent notion of "same edit" — the
 * detector must compare attempts by the *exact* value the fingerprint layer
 * produced, so the normalization rules and the oscillation triggers cannot
 * drift apart. The history element is therefore the 64-char lowercase-hex
 * SHA-256 string, never raw edit-set content.
 *
 * Two triggers fire an `editOscillation` halt, and they are INDEPENDENT
 * (either alone halts):
 *
 *  - **directRepeat** — the same fingerprint recurs across the history. The
 *    boundary is pinned: the halt fires only on the *third* same fingerprint
 *    (after the second repeat), not on the first A→A repeat, because a single
 *    isolated repeat could be an instructed revert rather than oscillation.
 *    directRepeat therefore scans *all* earlier attempts for a third
 *    recurrence, not just the immediately preceding one.
 *  - **3cycle** — attempt N's fingerprint equals attempt N−2's (an A → B → A
 *    pattern, A != B). This compares only N against N−2 (a fixed two-step
 *    lookback), because the pattern it names is specifically the alternation
 *    between two interpretations; a wider scan would re-derive directRepeat.
 *
 * Post-rejection guard (false-positive avoidance): a repeat is only counted
 * toward a trigger when the *repeating* attempt followed an evaluator
 * rejection. An attempt that reverts a partial edit because the evaluator said
 * "undo that" is instructed behaviour, not oscillation, so a repeat that did
 * not follow a rejection returns no halt — even though the fingerprints match.
 *
 * Security invariant: the seen-fingerprint accumulator is keyed by
 * caller-supplied (ultimately parsed-trace-derived) fingerprint strings, so it
 * is built with the same null-prototype / forbidden-key discipline as
 * `fingerprint.ts`, `loop-detection.ts`, and `sprint-budget.ts` — a value
 * literally named `__proto__` cannot pollute `Object.prototype`, crash the
 * detector, or collapse two genuinely-different histories into one false
 * repeat.
 */

import { createError, type ConfigServerError } from '../config-server/errors.js';
import type { CeilingDecision, LoopDetectedFields } from './loop-detection.js';

// Fingerprint values that must never index the seen-fingerprint accumulator:
// they are the prototype-pollution vectors. Mirrors `FORBIDDEN_KEYS` in
// `src/safety/fingerprint.ts` (and the role-keyed guards in
// `loop-detection.ts` / `sprint-budget.ts`) so the detector's keyed structure
// shares the one established defence rather than introducing a parallel one. A
// real fingerprint is 64 lowercase-hex chars, so none of these can ever be a
// genuine digest — but a hostile or malformed history could carry one as a
// "fingerprint", and folding it through a plain-object key would let it walk a
// prototype setter.
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

// A genuine fingerprint is a 64-char lowercase-hex SHA-256 digest. Used by the
// evidence validator to reject mis-shaped sequence elements; the detector
// itself compares opaque strings and does not
// require the input to match (a malformed history simply will not produce
// matching repeats), so this is validation, not a parsing gate.
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * The role whose fingerprint history is tracked for oscillation.
 *
 * Stamped on the `role` field of an `editOscillation` halt. It is the
 * kebab-case generator role id, the same key the per-role ceiling table uses —
 * the edit-fingerprint history is maintained for the generator role
 * specifically, so oscillation halts always carry this role. Kept distinct from
 * the sprint-budget halt's `"sprint"` sentinel so a trace reader can tell the
 * two halt classes apart by the `role` field.
 */
export const OSCILLATION_ROLE = 'gan-generator';

/**
 * Which of the two independent oscillation triggers fired.
 *
 * - `directRepeat` — the same fingerprint recurred a third time across the
 *   history (the second repeat).
 * - `3cycle` — attempt N's fingerprint equalled attempt N−2's (an A → B → A
 *   alternation).
 */
export type DetectedPattern = 'directRepeat' | '3cycle';

/**
 * One attempt's entry in the generator's edit-fingerprint history.
 *
 * @property fingerprint the 64-char lowercase-hex SHA-256 digest that
 *   {@link fingerprintEditSet} produced for the edit set this attempt proposed.
 *   The detector compares attempts by this exact value; it does not re-derive
 *   its own fingerprint from edit-set content.
 * @property followedRejection whether this attempt was made *after* an
 *   evaluator rejection (reconstructed from the trace's rejection record). A
 *   repeat is only counted toward a trigger when this flag is set on the
 *   repeating attempt — a repeat that did not follow a rejection is treated as
 *   an instructed/voluntary revert, not oscillation.
 */
export interface AttemptFingerprint {
  fingerprint: string;
  followedRejection: boolean;
}

/**
 * The generator's per-attempt fingerprint history, oldest attempt first.
 *
 * Modelled as an explicit ordered array (not a keyed object) because the
 * triggers are positional: 3cycle compares index N against N−2, and the
 * oldest-first order is what makes "attempt N−2" well-defined. The array index
 * is the attempt ordinal.
 */
export type FingerprintHistory = AttemptFingerprint[];

/**
 * The `editOscillation` evidence value carried on the `LoopDetected` error.
 *
 * @property fingerprintSequence the fingerprints that evidence the detected
 *   pattern, oldest first; each a 64-char lowercase-hex string. For a 3cycle
 *   halt this is the three-element A → B → A window, so `seq[0] === seq[2]`.
 *   For a directRepeat halt it is the history up to and including the third
 *   recurrence.
 * @property detectedPattern which trigger fired ({@link DetectedPattern}).
 */
export interface EditOscillationEvidence {
  fingerprintSequence: string[];
  detectedPattern: DetectedPattern;
}

/**
 * Narrow an arbitrary value to an {@link EditOscillationEvidence}.
 *
 * Mirrors the {@link isRoleCeilingEvidence} / {@link isSprintBudgetEvidence}
 * validator pattern (typed narrowing, no throw). The evidence shape is a
 * cross-version contract trace consumers rely on, so it is validated, not
 * merely produced.
 *
 * @param value the candidate, typically parsed from untrusted trace data.
 * @returns `true` iff `value` is an object with a `fingerprintSequence` array
 *   whose every element is a 64-char lowercase-hex string and a
 *   `detectedPattern` that is exactly `"directRepeat"` or `"3cycle"`. A
 *   mis-shaped value (wrong/extra-typed `detectedPattern`, a non-hex or
 *   wrong-length sequence element, a missing field) returns `false`. Pure;
 *   never throws.
 *
 *   Note: this validates the *shape*, not the pattern-specific invariant (e.g.
 *   `seq[0] === seq[2]` for a 3cycle). The producer
 *   ({@link detectEditOscillation}) guarantees that invariant; a shape
 *   validator must not reject a structurally-valid value just because a caller
 *   hand-built an inconsistent one.
 */
export function isEditOscillationEvidence(value: unknown): value is EditOscillationEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;

  if (v.detectedPattern !== 'directRepeat' && v.detectedPattern !== '3cycle') return false;

  const seq = v.fingerprintSequence;
  if (!Array.isArray(seq)) return false;
  // Every element must be a genuine fingerprint string. A non-hex or
  // wrong-length element means the value is not the digest sequence the trace
  // contract promises, so the whole value is rejected.
  for (const element of seq) {
    if (typeof element !== 'string' || !FINGERPRINT_RE.test(element)) return false;
  }
  return true;
}

/**
 * Decide whether the generator's edit-fingerprint history shows oscillation.
 *
 * Evaluates the two independent triggers over the history, oldest attempt
 * first, applying the post-rejection guard to each candidate repeat:
 *
 *  - **directRepeat** fires when a fingerprint recurs for the *third* time — the
 *    second repeat — and that third (current) attempt followed a rejection. The
 *    third-occurrence boundary is deliberate (the halt fires only after the
 *    second repeat): a single isolated A→A repeat could be an instructed
 *    revert, so two occurrences never halt. directRepeat scans all earlier
 *    attempts for the third recurrence rather than only the adjacent one.
 *  - **3cycle** fires when attempt N's fingerprint equals attempt N−2's (with
 *    the two differing from their neighbour, an A → B → A alternation) and
 *    attempt N followed a rejection. It compares only N against N−2 — a fixed
 *    two-step lookback — because that is the exact alternation it names;
 *    widening the scan would collapse it into directRepeat.
 *
 * The two triggers are checked independently and the earliest-firing one (by
 * attempt index) wins, so an A→B→A history halts via 3cycle even though no two
 * adjacent attempts repeat, and an A→A→A history halts via directRepeat.
 *
 * The check runs at attempt-start boundaries; an attempt already in flight
 * finishes before the next check.
 *
 * @param history the generator's per-attempt {@link FingerprintHistory},
 *   oldest first, each entry pairing the fingerprint with whether that attempt
 *   followed an evaluator rejection.
 * @param ceiling the attempt ceiling to record on the halt's `ceiling` field
 *   for trace consistency with the per-role/budget halts; defaults to the
 *   history length (the attempts seen so far) when omitted. This is the seed
 *   ceiling the generator role carries, surfaced here only for the halt
 *   contract — the oscillation triggers themselves do not consult it.
 * @returns a {@link CeilingDecision} (shared with the per-role and budget
 *   checks so all three halt paths return the same shape). `halt` is `true`
 *   iff a trigger fired with its post-rejection guard satisfied; when halting,
 *   `fields` carries the `LoopDetected` structured fields with
 *   `reason: "editOscillation"`, `role: "gan-generator"`, `attempts` = the
 *   history length, and an {@link EditOscillationEvidence} value. Pure; never
 *   throws — a forbidden-key or malformed fingerprint is handled as data and
 *   simply does not produce a match.
 */
export function detectEditOscillation(
  history: FingerprintHistory,
  ceiling?: number,
): CeilingDecision {
  // Null-prototype accumulator mapping each fingerprint to the count of times
  // it has appeared so far. Keyed by caller-supplied fingerprint strings, so it
  // uses the established forbidden-key + defineProperty discipline: a hostile
  // "__proto__" fingerprint is counted in a key-safe side channel rather than
  // walking a prototype setter (which could otherwise collapse two distinct
  // histories into one false repeat).
  const seenCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  // Forbidden-key fingerprints are counted here, keyed safely, so two different
  // histories that happen to use a pollution-named "fingerprint" are still told
  // apart rather than silently merged.
  const forbiddenCounts = new Map<string, number>();

  const countOf = (fp: string): number =>
    FORBIDDEN_KEYS.has(fp)
      ? forbiddenCounts.get(fp) ?? 0
      : Object.prototype.hasOwnProperty.call(seenCounts, fp)
        ? seenCounts[fp]
        : 0;

  const bump = (fp: string): void => {
    if (FORBIDDEN_KEYS.has(fp)) {
      forbiddenCounts.set(fp, (forbiddenCounts.get(fp) ?? 0) + 1);
      return;
    }
    // Define rather than assign so even a bypass of the guard above would
    // create a real own property, not trip a `__proto__` setter.
    Object.defineProperty(seenCounts, fp, {
      value: countOf(fp) + 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };

  for (let i = 0; i < history.length; i++) {
    const current = history[i];
    const fp = current.fingerprint;

    // The guard is checked on the *repeating* attempt (the current one): a
    // repeat that did not follow a rejection is an instructed revert, not
    // oscillation, so neither trigger may fire on it. We still count it below
    // so a *later* post-rejection repeat sees the full recurrence history.
    if (current.followedRejection) {
      // directRepeat: this attempt is the third occurrence of `fp` (two prior
      // appearances) — the second repeat. Two occurrences (one prior) is one
      // isolated repeat and must not halt, which is why the threshold is a
      // prior count of 2, not 1.
      if (countOf(fp) >= 2) {
        return haltDecision(buildSequenceUpTo(history, i), 'directRepeat', history.length, ceiling);
      }

      // 3cycle: attempt N equals attempt N−2 with the intervening attempt
      // different (A → B → A). Compared independently of directRepeat and only
      // against N−2, so an alternation with no adjacent repeat still halts.
      if (i >= 2) {
        const back2 = history[i - 2].fingerprint;
        const back1 = history[i - 1].fingerprint;
        if (fp === back2 && fp !== back1) {
          return haltDecision(
            [back2, back1, fp],
            '3cycle',
            history.length,
            ceiling,
          );
        }
      }
    }

    // Count every attempt's fingerprint, rejection-following or not: an
    // instructed revert is still a real occurrence that a subsequent
    // post-rejection repeat of the same fingerprint must be able to see, so the
    // guard suppresses the *halt*, never the bookkeeping.
    bump(fp);
  }

  return { halt: false };
}

// Build the `editOscillation` LoopDetectedFields + CeilingDecision for a fired
// trigger. Factored out so both trigger branches construct the halt the same
// way and the object-shaped evidence is cast onto the shared
// LoopDetectedFields.evidence at exactly one seam (mirroring sprint-budget.ts)
// rather than widening the shared field per discriminator.
function haltDecision(
  fingerprintSequence: string[],
  detectedPattern: DetectedPattern,
  attempts: number,
  ceiling: number | undefined,
): CeilingDecision {
  const evidence: EditOscillationEvidence = { fingerprintSequence, detectedPattern };
  const fields: LoopDetectedFields = {
    reason: 'editOscillation',
    role: OSCILLATION_ROLE,
    attempts,
    // The oscillation triggers do not consult a ceiling; the field exists only
    // for halt-contract parity with the per-role/budget halts, so it defaults
    // to the attempts seen when the caller does not supply the role's ceiling.
    ceiling: ceiling ?? attempts,
    // The shared LoopDetectedFields.evidence is typed for the role-ceiling
    // array; the editOscillation discriminator carries an object instead. Cast
    // at this single seam (validated by isEditOscillationEvidence in tests)
    // rather than widening the shared field for every discriminator — the same
    // structure sprint-budget.ts uses.
    evidence: evidence as unknown as LoopDetectedFields['evidence'],
  };
  return { halt: true, fields };
}

// The directRepeat evidence window: the fingerprints from the oldest attempt
// through the third-recurring attempt at `index` (inclusive). The full prefix
// is included so a trace reader sees the recurrence in context, not just the
// three matching digests.
function buildSequenceUpTo(history: FingerprintHistory, index: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= index; i++) out.push(history[i].fingerprint);
  return out;
}

/**
 * Render the user-facing prose halt message for an edit-oscillation halt.
 *
 * Obeys the same user-facing-error discipline as the per-role and sprint-budget
 * messages: it names no maintainer-only scripts and no ecosystem/runtime
 * tooling, refers to "the framework" / "ClaudeAgents", points the user at the
 * run's trace directory (the read-substrate for the halt, since v1.0 ships
 * without a trace command), and tells them to re-run with `--recover` after
 * adjusting the prompt. The trace path is templated, not hardcoded, so the
 * central-store location can be substituted by the caller.
 *
 * @param fields the structured halt fields; `attempts` is interpolated and the
 *   `role` is the `gan-generator` id (not interpolated as prose).
 * @param detectedPattern which trigger fired, so the message can name whether
 *   the generator repeated one edit or alternated between two.
 * @param traceDir the run's trace directory path to point the user at.
 * @returns the prose message. Pure; never throws.
 */
export function renderEditOscillationMessage(
  fields: Pick<LoopDetectedFields, 'attempts'>,
  detectedPattern: DetectedPattern,
  traceDir: string,
): string {
  // directRepeat means the generator re-proposed the same edit; 3cycle means it
  // alternated between two — the two failure shapes, surfaced so the user
  // knows which without reading the evidence array.
  const shape =
    detectedPattern === 'directRepeat'
      ? 're-proposed the same change'
      : 'alternated between two interpretations';
  return (
    `ClaudeAgents halted this sprint: the generator made ${fields.attempts} attempts and ` +
    `${shape} rather than converging, so the framework stopped it rather than keep retrying ` +
    `a step that is not making progress. Trace files for this run are at ${traceDir}. ` +
    `Adjust the prompt, then re-run with --recover to resume.`
  );
}

/**
 * Construct the `LoopDetected` structured error for an edit-oscillation halt.
 *
 * Reuses the framework's existing `createError('LoopDetected', ...)` factory —
 * the SAME error code, fields, and serialisation the per-role
 * {@link createLoopDetectedError} and the {@link createSprintBudgetError} use —
 * so the oscillation halt is not a parallel error path. Only the discriminator
 * (`editOscillation`), the `gan-generator` role, and the
 * {@link EditOscillationEvidence} evidence shape differ; the message comes from
 * {@link renderEditOscillationMessage}.
 *
 * @param fields the structured halt fields to attach (from
 *   {@link detectEditOscillation}); its `evidence` is the object-shaped
 *   {@link EditOscillationEvidence}, from which the message reads the pattern.
 * @param traceDir the run's trace directory, used to render the message.
 * @returns a constructed (not thrown) `ConfigServerError` with code
 *   `LoopDetected`. Pure; never throws (it constructs, it does not raise).
 */
export function createEditOscillationError(
  fields: LoopDetectedFields,
  traceDir: string,
): ConfigServerError {
  // Read the pattern off the object-shaped evidence at the same seam the
  // detector cast it through; fall back to directRepeat phrasing only if a
  // caller hand-built fields without a recognisable pattern (the detector
  // always supplies one).
  const evidence = fields.evidence as unknown as EditOscillationEvidence;
  const detectedPattern: DetectedPattern =
    evidence && evidence.detectedPattern === '3cycle' ? '3cycle' : 'directRepeat';

  return createError('LoopDetected', {
    message: renderEditOscillationMessage(fields, detectedPattern, traceDir),
    reason: fields.reason,
    role: fields.role,
    attempts: fields.attempts,
    ceiling: fields.ceiling,
    evidence: fields.evidence,
  });
}
