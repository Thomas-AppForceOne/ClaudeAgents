/**
 * Cross-document invariant registry for the config-server's validation phase 3.
 *
 * Schema validation (phase 2) checks each overlay/stack file in isolation;
 * invariants are the checks that need the *whole* {@link ValidationSnapshot} —
 * relationships between files, between tiers, or between a stack and the module
 * it pairs with. Every invariant is a pure function from the snapshot to a list
 * of {@link Issue}s: it reads only what discovery already loaded and never
 * touches disk on the hot path beyond confirming a referenced file exists.
 *
 * This module is the single place that lists which invariants run and in what
 * order. {@link runAllInvariants} fans the snapshot out to each registered
 * check and concatenates their issues; callers (the validate tools) treat the
 * combined list as the phase-3 output.
 */

import type { Issue } from '../validation/schema-check.js';
import type { ValidationSnapshot } from '../tools/validate.js';

import { checkAdditionalContextPathResolves } from './additional-context-path-resolves.js';
import { checkCacheEnvNoConflict } from './cache-env-no-conflict.js';
import { checkDetectionTier3Only } from './detection-tier3-only.js';
import { checkOverlayTierApiVersion } from './overlay-tier-api-version.js';
import { checkPairsWithConsistency } from './pairs-with-consistency.js';
import { checkPathEscape } from './path-escape.js';
import { checkStackNoDraftBanner } from './stack-no-draft-banner.js';
import { checkStackTierApiVersion } from './stack-tier-api-version.js';

/**
 * One entry in the invariant registry.
 *
 * @property id stable dotted identifier for the invariant (e.g.
 *   `path.escape`); surfaced in logs/diagnostics and used by tests to address a
 *   single check, so it must not change once shipped.
 * @property check the pure invariant function: given the full snapshot it
 *   returns zero or more {@link Issue}s. Never throws for a normal validation
 *   outcome — a detected violation is returned as data, not raised.
 */
export interface InvariantRegistration {
  id: string;
  check: (snapshot: ValidationSnapshot) => Issue[];
}

/**
 * The ordered list of invariants run during validation. Order is the iteration
 * order of {@link runAllInvariants}, so it determines the relative ordering of
 * issues from different invariants in the combined output; keep it stable so
 * diagnostics and snapshot tests stay deterministic.
 */
export const INVARIANTS: InvariantRegistration[] = [
  { id: 'additionalContext.path_resolves', check: checkAdditionalContextPathResolves },
  { id: 'cacheEnv.no_conflict', check: checkCacheEnvNoConflict },
  { id: 'detection.tier3_only', check: checkDetectionTier3Only },
  { id: 'overlay.tier_apiVersion', check: checkOverlayTierApiVersion },
  { id: 'pairsWith.consistency', check: checkPairsWithConsistency },
  { id: 'path.escape', check: checkPathEscape },
  { id: 'stack.no_draft_banner', check: checkStackNoDraftBanner },
  { id: 'stack.tier_apiVersion', check: checkStackTierApiVersion },
];

/**
 * Run every registered invariant against `snapshot` and return the flattened
 * list of issues, in registry order.
 *
 * Has no side effects and never throws on a normal validation outcome (each
 * check is pure and returns violations as data); an empty result means no
 * cross-document invariant was violated. An invariant that throws would
 * propagate, but that signals a programming fault, not a config problem.
 *
 * @param snapshot the fully-discovered validation snapshot (stacks, overlays,
 *   modules); each invariant reads only the parts it needs.
 * @returns all issues produced by all invariants, concatenated; possibly empty.
 */
export function runAllInvariants(snapshot: ValidationSnapshot): Issue[] {
  const out: Issue[] = [];
  for (const reg of INVARIANTS) {
    const produced = reg.check(snapshot);
    if (produced.length > 0) out.push(...produced);
  }
  return out;
}
