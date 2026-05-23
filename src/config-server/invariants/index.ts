

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

export interface InvariantRegistration {
  id: string;
  check: (snapshot: ValidationSnapshot) => Issue[];
}

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

export function runAllInvariants(snapshot: ValidationSnapshot): Issue[] {
  const out: Issue[] = [];
  for (const reg of INVARIANTS) {
    const produced = reg.check(snapshot);
    if (produced.length > 0) out.push(...produced);
  }
  return out;
}
