/**
 * T1 Sprint 3 — the evidence-bundle verifier (F3.2).
 *
 * Given a produced evaluator evidence bundle, the criteria of the matching
 * `sprint-{N}-contract.json`, and the run's trace events, this helper reports
 * whether the bundle is well-formed against the four T1 invariants:
 *
 *  1. SCHEMA — the bundle validates against `evaluator-evidence-bundle-v1.json`
 *     by REUSING the Sprint-1 `getEvaluatorEvidenceBundleValidator` (not a
 *     hand-rolled re-validation). ajv errors are surfaced, not swallowed.
 *  2. JOIN-KEY — every `criteria[].name` matches a `criteria[].name` present
 *     in the supplied contract criteria (pure set membership; no I/O beyond
 *     the inputs handed in).
 *  3. REF-INTEGRITY — every `evidence.traceEventRefs` entry, of the form
 *     `<eventType>:<sequenceNumber>`, resolves to an event actually present in
 *     the supplied trace events (eventType AND sequenceNumber both match). An
 *     empty `traceEventRefs` (permitted for `verdict='skipped'`) trivially
 *     resolves.
 *  4. FAIL-COMPLETENESS — any criterion with `verdict='fail'` carries BOTH a
 *     non-empty `evidence.reproductionCommand` AND `evidence.deltaFromContract`
 *     `{expected, observed}`. This is re-asserted as a SEMANTIC check on top
 *     of the schema's conditional-required clause, so a future schema
 *     relaxation cannot silently drop the guarantee.
 *
 * The verifier returns a structured result that names the offending bundle
 * criterion names / refs per failed check, so the caller (and a test) can
 * point at the exact cause. It never throws on a malformed bundle: a bad
 * bundle is reported, not raised.
 */

import { getEvaluatorEvidenceBundleValidator } from '../config-server/validation/schema-check.js';
import type { TraceEvent } from './events.js';

/** A criterion as it appears in a `sprint-{N}-contract.json`. Only the join key is read. */
export interface ContractCriterionLike {
  name: string;
}

/** The four named checks the verifier runs, in evaluation order. */
export type EvidenceBundleCheck = 'schema' | 'joinKey' | 'refIntegrity' | 'failCompleteness';

/** A single failure, naming the check and the offending item. */
export interface EvidenceBundleFailure {
  /** Which invariant failed. */
  check: EvidenceBundleCheck;
  /** Human-readable detail naming the offending criterion name / ref / ajv error. */
  detail: string;
  /** The offending bundle criterion name, when the failure is criterion-scoped. */
  criterionName?: string;
  /** The unresolved trace ref, when the failure is a dangling reference. */
  unresolvedRef?: string;
}

/** The structured verifier result. */
export interface EvidenceBundleVerifyResult {
  /** True iff every check passed. */
  ok: boolean;
  /** True iff the bundle validated against the Sprint-1 schema. */
  schemaValid: boolean;
  /** The ajv errors verbatim when `schemaValid` is false (surfaced, not swallowed). */
  schemaErrors: unknown[];
  /** Every failure across all checks, in evaluation order. */
  failures: EvidenceBundleFailure[];
}

/** Minimal shape the post-schema checks read off a criterion. */
export interface BundleCriterion {
  name: string;
  verdict: 'pass' | 'fail' | 'blocked' | 'skipped';
  evidence: {
    traceEventRefs: string[];
    reproductionCommand?: string;
    deltaFromContract?: { expected: string; observed: string };
  };
}

interface EvidenceBundleLike {
  criteria: BundleCriterion[];
}

/**
 * The load-bearing FAIL-COMPLETENESS invariant, as a standalone SEMANTIC
 * predicate (F3.2): a `verdict='fail'` criterion must carry BOTH a non-empty
 * `evidence.reproductionCommand` AND `evidence.deltaFromContract` with string
 * `expected`/`observed`. Exposed (and applied by `verifyEvidenceBundle`) so the
 * guarantee is asserted IN ADDITION to the schema's conditional-required
 * clause — a future schema relaxation cannot silently drop it. Returns the
 * list of missing requirements (empty when complete); a non-`fail` verdict is
 * trivially complete.
 */
export function checkFailCompleteness(
  criterion: Pick<BundleCriterion, 'verdict' | 'evidence'>,
): Array<'reproductionCommand' | 'deltaFromContract'> {
  if (criterion.verdict !== 'fail') return [];
  const missing: Array<'reproductionCommand' | 'deltaFromContract'> = [];
  const repro = criterion.evidence.reproductionCommand;
  if (typeof repro !== 'string' || repro.length === 0) missing.push('reproductionCommand');
  const delta = criterion.evidence.deltaFromContract;
  if (
    delta === undefined ||
    typeof delta.expected !== 'string' ||
    typeof delta.observed !== 'string'
  ) {
    missing.push('deltaFromContract');
  }
  return missing;
}

/**
 * Parse a `<eventType>:<sequenceNumber>` ref into its parts. Returns `null`
 * for a ref that does not match the shape; the schema already pins the
 * pattern, so a parse miss here is defensive.
 */
function parseRef(ref: string): { eventType: string; sequenceNumber: number } | null {
  const idx = ref.lastIndexOf(':');
  if (idx <= 0 || idx === ref.length - 1) return null;
  const eventType = ref.slice(0, idx);
  const seqStr = ref.slice(idx + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(seqStr)) return null;
  return { eventType, sequenceNumber: Number(seqStr) };
}

/**
 * Verify a produced evidence bundle against the four T1 invariants.
 *
 * @param bundle the produced evaluator evidence bundle (parsed JSON; treated
 *   as untrusted — schema validation is the first gate).
 * @param contractCriteria the `criteria[]` of the matching
 *   `sprint-{N}-contract.json`; only each `name` is read (the join key).
 * @param traceEvents the run's trace events (e.g. from `scanEvents`); refs
 *   resolve against this set.
 */
export function verifyEvidenceBundle(
  bundle: unknown,
  contractCriteria: readonly ContractCriterionLike[],
  traceEvents: readonly TraceEvent[],
): EvidenceBundleVerifyResult {
  const failures: EvidenceBundleFailure[] = [];

  // ---- Check 1: SCHEMA (reuse the Sprint-1 validator) -------------------
  const validate = getEvaluatorEvidenceBundleValidator();
  const schemaValid = validate(bundle) as boolean;
  const schemaErrors: unknown[] = schemaValid ? [] : [...(validate.errors ?? [])];
  if (!schemaValid) {
    failures.push({
      check: 'schema',
      detail:
        'The evidence bundle did not validate against evaluator-evidence-bundle-v1.json: ' +
        JSON.stringify(schemaErrors),
    });
    // Without a schema-valid bundle the structural shape is untrustworthy, so
    // the semantic checks below would be reading unvalidated input. Stop here
    // and surface the ajv errors verbatim.
    return { ok: false, schemaValid, schemaErrors, failures };
  }

  const typed = bundle as EvidenceBundleLike;

  // ---- Check 2: JOIN-KEY (pure set membership) --------------------------
  const contractNames = new Set(contractCriteria.map((c) => c.name));
  for (const crit of typed.criteria) {
    if (!contractNames.has(crit.name)) {
      failures.push({
        check: 'joinKey',
        criterionName: crit.name,
        detail:
          `Bundle criterion '${crit.name}' has no matching criterion in the ` +
          `corresponding sprint contract (the join key does not resolve).`,
      });
    }
  }

  // ---- Check 3: REF-INTEGRITY -------------------------------------------
  // Index the trace events by `<eventType>:<sequenceNumber>` for O(1) lookup.
  const presentRefs = new Set<string>();
  for (const ev of traceEvents) {
    presentRefs.add(`${ev.eventType}:${ev.sequenceNumber}`);
  }
  for (const crit of typed.criteria) {
    for (const ref of crit.evidence.traceEventRefs) {
      const parsed = parseRef(ref);
      if (parsed === null || !presentRefs.has(`${parsed.eventType}:${parsed.sequenceNumber}`)) {
        failures.push({
          check: 'refIntegrity',
          criterionName: crit.name,
          unresolvedRef: ref,
          detail:
            `Bundle criterion '${crit.name}' references trace event '${ref}', which ` +
            `does not resolve to an event present in the run's trace (no event with ` +
            `that eventType and sequenceNumber).`,
        });
      }
    }
  }

  // ---- Check 4: FAIL-COMPLETENESS (semantic re-assert) ------------------
  // Uses the standalone `checkFailCompleteness` predicate so the guarantee is
  // re-asserted in addition to the schema's conditional-required clause.
  for (const crit of typed.criteria) {
    for (const missing of checkFailCompleteness(crit)) {
      failures.push({
        check: 'failCompleteness',
        criterionName: crit.name,
        detail:
          missing === 'reproductionCommand'
            ? `Bundle criterion '${crit.name}' has verdict='fail' but is missing a ` +
              `non-empty evidence.reproductionCommand.`
            : `Bundle criterion '${crit.name}' has verdict='fail' but is missing ` +
              `evidence.deltaFromContract {expected, observed}.`,
      });
    }
  }

  return { ok: failures.length === 0, schemaValid, schemaErrors, failures };
}
