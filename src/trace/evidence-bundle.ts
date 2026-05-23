

import { getEvaluatorEvidenceBundleValidator } from '../config-server/validation/schema-check.js';
import type { TraceEvent } from './events.js';

export interface ContractCriterionLike {
  name: string;
}

export type EvidenceBundleCheck = 'schema' | 'joinKey' | 'refIntegrity' | 'failCompleteness';

export interface EvidenceBundleFailure {

  check: EvidenceBundleCheck;

  detail: string;

  criterionName?: string;

  unresolvedRef?: string;
}

export interface EvidenceBundleVerifyResult {

  ok: boolean;

  schemaValid: boolean;

  schemaErrors: unknown[];

  failures: EvidenceBundleFailure[];
}

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

function parseRef(ref: string): { eventType: string; sequenceNumber: number } | null {
  const idx = ref.lastIndexOf(':');
  if (idx <= 0 || idx === ref.length - 1) return null;
  const eventType = ref.slice(0, idx);
  const seqStr = ref.slice(idx + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(seqStr)) return null;
  return { eventType, sequenceNumber: Number(seqStr) };
}

export function verifyEvidenceBundle(
  bundle: unknown,
  contractCriteria: readonly ContractCriterionLike[],
  traceEvents: readonly TraceEvent[],
): EvidenceBundleVerifyResult {
  const failures: EvidenceBundleFailure[] = [];

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

    return { ok: false, schemaValid, schemaErrors, failures };
  }

  const typed = bundle as EvidenceBundleLike;

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
