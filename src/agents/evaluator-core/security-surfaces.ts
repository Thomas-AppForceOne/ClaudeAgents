/**
 * C1 `securitySurfaces` template instantiation.
 *
 * Implements the algorithm in C1 "Template instantiation protocol"
 * (lines 188-195) as a pure function:
 *
 *   1. Compute the set of files the sprint touches (from `sprintPlan.affectedFiles`).
 *   2. Intersect with the surface's `triggers.scope` globs (if present)
 *      AND the stack's own `scope` globs. If empty, skip.
 *   3. If `triggers.keywords` is present, scan the touched files'
 *      contents for any keyword. If none match, skip.
 *   4. Otherwise instantiate. Template is verbatim — no interpolation.
 *      Variable evidence (matched files, matched keywords) is recorded
 *      under `triggerEvidence`.
 *
 * Surfaces with neither `triggers.scope` nor `triggers.keywords` are
 * instantiated unconditionally whenever the stack is active and the
 * sprint touches any file in the stack's `scope`.
 *
 * Cross-contamination guard: a surface from stack A only sees files in
 * stack A's `scope`. A polyglot fixture where stack B's files are
 * touched does NOT instantiate stack A's surfaces against those files.
 *
 * Output is sorted by `(stack, id)` so the plan is byte-stable.
 */

import picomatch from 'picomatch';

import type {
  EvaluatorCoreSnapshot,
  EvaluatorPlan,
  SecuritySurface,
  SprintPlan,
  WorktreeState,
} from './types.js';

export function buildSecuritySurfacesInstantiated(
  snapshot: EvaluatorCoreSnapshot,
  sprintPlan: SprintPlan,
  worktree: WorktreeState,
): EvaluatorPlan['securitySurfacesInstantiated'] {
  const rows: EvaluatorPlan['securitySurfacesInstantiated'] = [];
  const fileContents = worktree.fileContents ?? {};

  for (const stack of snapshot.activeStacks) {
    const surfaces = stack.securitySurfaces ?? [];
    if (surfaces.length === 0) continue;

    // Files the sprint touches that are also inside this stack's scope.
    const stackScopedTouched = filterByGlobs(sprintPlan.affectedFiles, stack.scope);

    for (const surface of surfaces) {
      const instantiated = instantiateSurface(stack.name, surface, stackScopedTouched, fileContents);
      if (instantiated !== null) rows.push(instantiated);
    }
  }

  // Sort by (stack, id) so cross-stack surfaces with the same id remain
  // in deterministic order.
  rows.sort((a, b) => {
    const byStack = a.stack.localeCompare(b.stack, undefined, {
      sensitivity: 'variant',
      numeric: false,
    });
    if (byStack !== 0) return byStack;
    return a.id.localeCompare(b.id, undefined, {
      sensitivity: 'variant',
      numeric: false,
    });
  });
  return rows;
}

function instantiateSurface(
  stackName: string,
  surface: SecuritySurface,
  stackScopedTouched: readonly string[],
  fileContents: Record<string, string>,
): EvaluatorPlan['securitySurfacesInstantiated'][number] | null {
  const triggers = surface.triggers ?? {};
  const triggerScope = triggers.scope ?? [];
  const triggerKeywords = triggers.keywords ?? [];

  // Step 2: intersect with surface.triggers.scope (if present).
  let candidateFiles: readonly string[];
  if (triggerScope.length > 0) {
    candidateFiles = filterByGlobs(stackScopedTouched, triggerScope);
    if (candidateFiles.length === 0) return null;
  } else {
    // No trigger.scope → use stack-scoped touched files directly.
    candidateFiles = stackScopedTouched;
  }

  // If there are no triggers at all and the stack scope was non-empty
  // touched, still require at least one touched file to instantiate
  // (per "sprint touches any file in the stack's scope").
  if (triggerScope.length === 0 && triggerKeywords.length === 0) {
    if (stackScopedTouched.length === 0) return null;
  }

  // Step 3: keyword search across candidate files.
  let keywordsHit: string[] = [];
  let scopeMatched: string[];
  if (triggerKeywords.length > 0) {
    const matched: { file: string; keyword: string }[] = [];
    for (const file of candidateFiles) {
      const content = fileContents[file];
      if (typeof content !== 'string') continue; // missing content → skip silently
      for (const kw of triggerKeywords) {
        if (kw.length > 0 && content.includes(kw)) {
          matched.push({ file, keyword: kw });
        }
      }
    }
    if (matched.length === 0) return null;
    const fileSet = new Set<string>();
    const keywordSet = new Set<string>();
    for (const m of matched) {
      fileSet.add(m.file);
      keywordSet.add(m.keyword);
    }
    scopeMatched = localeSort(Array.from(fileSet));
    keywordsHit = localeSort(Array.from(keywordSet));
  } else {
    scopeMatched = localeSort([...candidateFiles]);
  }

  return {
    stack: stackName,
    id: surface.id,
    templateText: surface.template,
    triggerEvidence: { scopeMatched, keywordsHit },
    appliesToFiles: scopeMatched.slice(),
  };
}

function filterByGlobs(candidates: readonly string[], patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [];
  const matched: string[] = [];
  for (const c of candidates) {
    for (const pattern of patterns) {
      const isMatch = picomatch(pattern, { dot: true });
      if (isMatch(c)) {
        matched.push(c);
        break;
      }
    }
  }
  return localeSort(matched);
}

function localeSort(items: readonly string[]): string[] {
  const copy = items.slice();
  copy.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return copy;
}
