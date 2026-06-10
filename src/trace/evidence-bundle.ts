/**
 * Evidence-bundle verifier — checks that an evaluator's verdicts are backed by
 * real, resolvable evidence in a run's trace.
 *
 * An evidence bundle is the evaluator's structured claim: for each contract
 * criterion, a verdict plus references to the trace events that justify it.
 * {@link verifyEvidenceBundle} runs four checks in a fixed order and collects
 * every failure (it does not stop at the first) so a caller sees the full
 * picture in one pass:
 *
 * 1. schema — the bundle validates against `evaluator-evidence-bundle-v1.json`.
 *    This is a hard gate: a schema-invalid bundle cannot be trusted to have the
 *    shape the later checks assume, so verification returns immediately.
 * 2. joinKey — every bundle criterion name resolves to a contract criterion.
 * 3. refIntegrity — every cited `eventType:sequenceNumber` ref resolves to an
 *    event actually present in the trace.
 * 4. failCompleteness — a `fail` verdict carries the reproduction command and
 *    expected/observed delta needed to act on it.
 *
 * All outcomes are returned as data in {@link EvidenceBundleVerifyResult}; this
 * module never throws for a verification failure.
 */

import { getEvaluatorEvidenceBundleV2Validator } from '../config-server/validation/schema-check.js';
import { assertEvaluatorEvidenceDigest } from '../config-server/invariants/evaluator-evidence-digest.js';
import type { TraceEvent } from './events.js';

/**
 * Minimal shape of a contract criterion needed for the join-key check: just
 * its `name`. Accepting this structural subset lets callers pass full contract
 * criteria without this module depending on their richer type.
 */
export interface ContractCriterionLike {
  name: string;
}

/**
 * The verification checks the bundle verifier runs; the `check` discriminant
 * on a failure. `digest` was added by the T5 spec — the bundle must carry the
 * SHA-256 hex digest of the evaluator-prompt stamped by the orchestrator at
 * spawn time, so two bundles produced under different evaluator-prompts are
 * distinguishable in the audit trail.
 */
export type EvidenceBundleCheck =
  | 'schema'
  | 'joinKey'
  | 'refIntegrity'
  | 'failCompleteness'
  | 'digest';

/**
 * One verification failure.
 *
 * @property check which check produced it.
 * @property detail human-readable explanation.
 * @property criterionName the offending criterion, when the failure is scoped
 *   to one (absent for the bundle-wide schema failure).
 * @property unresolvedRef the specific trace-event ref that did not resolve,
 *   present only for `refIntegrity` failures.
 */
export interface EvidenceBundleFailure {

  check: EvidenceBundleCheck;

  detail: string;

  criterionName?: string;

  unresolvedRef?: string;
}

/**
 * Aggregate verification result.
 *
 * @property ok `true` iff `failures` is empty.
 * @property schemaValid whether the bundle passed JSON-schema validation.
 * @property schemaErrors the schema validator's raw errors (empty when valid).
 * @property failures every failure across all checks; empty means fully verified.
 */
export interface EvidenceBundleVerifyResult {

  ok: boolean;

  schemaValid: boolean;

  schemaErrors: unknown[];

  failures: EvidenceBundleFailure[];
}

/**
 * One criterion within an evidence bundle: a verdict plus the evidence backing
 * it (trace-event refs, and — for failures — a reproduction command and the
 * expected-vs-observed delta).
 */
export interface BundleCriterion {
  name: string;
  verdict: 'pass' | 'fail' | 'blocked' | 'skipped';
  evidence: {
    traceEventRefs: string[];
    reproductionCommand?: string;
    deltaFromContract?: { expected: string; observed: string };
  };
}

// Post-schema-validation view of the bundle. Only used after schema validation
// has confirmed the shape, so the typed access below is safe.
interface EvidenceBundleLike {
  criteria: BundleCriterion[];
}

/**
 * Report which fail-completeness fields a criterion is missing. A non-`fail`
 * verdict has no completeness requirement and yields `[]`. A `fail` verdict
 * must carry a non-empty `reproductionCommand` and a `deltaFromContract` with
 * string `expected`/`observed`; each that is absent or wrong-typed is named in
 * the result.
 *
 * @param criterion the verdict + evidence to inspect (the rest of the
 *   criterion is irrelevant here, hence the `Pick`).
 * @returns the missing field names; empty when complete (or not a fail).
 *   Returned as data — never throws.
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

// Parse an `eventType:sequenceNumber` ref into its parts, or null if
// malformed. Split on the LAST colon so an eventType is free to contain colons
// itself; reject an empty type (idx<=0) or empty seq (idx at end), and require
// the seq to be a canonical non-negative integer with no leading zeros so each
// event has exactly one valid ref spelling.
function parseRef(ref: string): { eventType: string; sequenceNumber: number } | null {
  const idx = ref.lastIndexOf(':');
  if (idx <= 0 || idx === ref.length - 1) return null;
  const eventType = ref.slice(0, idx);
  const seqStr = ref.slice(idx + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(seqStr)) return null;
  return { eventType, sequenceNumber: Number(seqStr) };
}

/**
 * Verify an evidence bundle against its sprint contract and the run's trace,
 * running all four checks (see the module block) and collecting every failure.
 *
 * @param bundle the untrusted evidence bundle; validated against
 *   `evaluator-evidence-bundle-v1.json` before any field is read.
 * @param contractCriteria the sprint contract's criteria; supplies the set of
 *   valid criterion names for the join-key check.
 * @param traceEvents the run's events; supplies the set of resolvable
 *   `eventType:sequenceNumber` refs for the ref-integrity check.
 * @returns an {@link EvidenceBundleVerifyResult}; `ok` is true only when no
 *   check failed. Never throws — a schema-invalid bundle short-circuits to a
 *   single schema failure rather than risking a read against a malformed shape.
 */
export function verifyEvidenceBundle(
  bundle: unknown,
  contractCriteria: readonly ContractCriterionLike[],
  traceEvents: readonly TraceEvent[],
): EvidenceBundleVerifyResult {
  const failures: EvidenceBundleFailure[] = [];

  const validate = getEvaluatorEvidenceBundleV2Validator();
  const schemaValid = validate(bundle) as boolean;
  const schemaErrors: unknown[] = schemaValid ? [] : [...(validate.errors ?? [])];
  if (!schemaValid) {
    failures.push({
      check: 'schema',
      detail:
        'The evidence bundle did not validate against evaluator-evidence-bundle-v1.json: ' +
        JSON.stringify(schemaErrors),
    });

    // Hard gate: the later checks read `bundle` as EvidenceBundleLike, which is
    // only sound once the schema has confirmed the shape. Bail before that.
    return { ok: false, schemaValid, schemaErrors, failures };
  }

  // Safe only because the schema check above succeeded.
  const typed = bundle as EvidenceBundleLike;

  // The orchestrator-stamped digest is asserted here as the consumer-side
  // gate (T5). The check runs after the schema gate so a malformed bundle
  // produces one focused schema failure rather than co-firing; a bundle that
  // is schema-valid but lacks the digest (a v1-shaped legacy artefact
  // reaching the v2 read path) is rejected with the structured-code surface
  // the assert returns.
  const digestResult = assertEvaluatorEvidenceDigest(bundle);
  if (!digestResult.ok) {
    failures.push({
      check: 'digest',
      detail: digestResult.message ?? 'evaluator-evidence-bundle digest check failed.',
    });
  }

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

  // Precompute the set of resolvable refs once (O(events)), so the nested
  // per-criterion ref loop below is O(refs) lookups rather than O(refs*events).
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
