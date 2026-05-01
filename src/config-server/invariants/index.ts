/**
 * Cross-file invariant registry (R1, sprint 4).
 *
 * Phase 3 of `validateAll()` runs every invariant catalogued in F3 that R1
 * owns (8 of the 9; `trust.approved` is owned by R5 and is omitted until
 * R5 ships). Each invariant lives in its own file under this directory —
 * one file per F3-cataloged check — and exports a single check function
 * with the shape:
 *
 *   export function checkXyz(snapshot: ValidationSnapshot): Issue[];
 *
 * The registry below collects them in a deterministic order (alphabetical
 * by id) and runs each one without short-circuit. Every callable that
 * needs to evaluate a cross-file invariant — `validateAll`'s phase 3,
 * R4's `lint-stacks` script, future build-time checks — imports from this
 * registry. There is no second implementation anywhere in the codebase
 * (R1's "single-implementation rule" — see `PROJECT_CONTEXT.md`).
 *
 * Invariants return `Issue[]`, never throw. A check that needs to bail
 * (e.g. snapshot missing required fields) returns `[]`. Issue codes are
 * drawn from F2's enum; `InvariantViolation` is the typical one for the
 * checks owned here. No new error codes are introduced by S4.
 */

import type { Issue } from '../validation/schema-check.js';
import type { ValidationSnapshot } from '../tools/validate.js';

import { checkAdditionalContextPathResolves } from './additional-context-path-resolves.js';
import { checkCacheEnvNoConflict } from './cache-env-no-conflict.js';
import { checkDetectionTier3Only } from './detection-tier3-only.js';
import { checkOverlayTierApiVersion } from './overlay-tier-api-version.js';
import { checkPairsWithConsistency } from './pairs-with-consistency.js';
import { checkPathNoEscape } from './path-no-escape.js';
import { checkStackNoDraftBanner } from './stack-no-draft-banner.js';
import { checkStackTierApiVersion } from './stack-tier-api-version.js';

/**
 * Shape of a registry entry: the F3-catalog id of the invariant, plus the
 * pure check function. Order in the exported array is alphabetical by id
 * (deterministic — F3 determinism contract).
 */
export interface InvariantRegistration {
  id: string;
  check: (snapshot: ValidationSnapshot) => Issue[];
}

/**
 * The full set of cross-file invariants R1 owns. R4 lint, validateAll's
 * phase 3, and any future caller iterate this list; no caller hard-codes
 * a subset. New invariants land by adding a file under this directory and
 * a row to this array (kept alphabetical by id).
 */
export const INVARIANTS: InvariantRegistration[] = [
  { id: 'additionalContext.path_resolves', check: checkAdditionalContextPathResolves },
  { id: 'cacheEnv.no_conflict', check: checkCacheEnvNoConflict },
  { id: 'detection.tier3_only', check: checkDetectionTier3Only },
  { id: 'overlay.tier_apiVersion', check: checkOverlayTierApiVersion },
  { id: 'pairsWith.consistency', check: checkPairsWithConsistency },
  { id: 'path.no_escape', check: checkPathNoEscape },
  { id: 'stack.no_draft_banner', check: checkStackNoDraftBanner },
  { id: 'stack.tier_apiVersion', check: checkStackTierApiVersion },
];

/**
 * Run every invariant against the snapshot and return the concatenated
 * issue list. Order is registry order (alphabetical by id) so callers can
 * rely on a stable cross-run output ordering. No short-circuit: a check
 * that returns 1+ issues does not prevent later checks from running.
 */
export function runAllInvariants(snapshot: ValidationSnapshot): Issue[] {
  const out: Issue[] = [];
  for (const reg of INVARIANTS) {
    const produced = reg.check(snapshot);
    if (produced.length > 0) out.push(...produced);
  }
  return out;
}
