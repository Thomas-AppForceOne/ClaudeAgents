

/**
 * The shared surface-instantiation engine used by both the security and
 * documentation surface builders. Given a set of stacks (each with a scope and
 * a list of surfaces) plus the sprint's affected files, it decides which
 * surfaces "fire" and against which files, returning a deterministically
 * sorted list of instantiated rows.
 *
 * Trigger model (a surface fires when all of its declared triggers pass):
 * - first the affected files are narrowed to the stack's `scope`;
 * - a surface's `triggers.scope` (if any) narrows further — no match means the
 *   surface does not fire;
 * - a surface's `triggers.keywords` (if any) require at least one keyword to
 *   appear in some candidate file's contents — and only the files that
 *   actually contained a keyword end up in the evidence;
 * - a surface with no triggers at all fires whenever the stack touched any
 *   in-scope file.
 *
 * All globbing uses picomatch with `{ dot: true }` so dotfiles participate.
 */

import picomatch from 'picomatch';

/** Minimal structural shape an input surface must have to be instantiated;
 *  matches both {@link SecuritySurface} and {@link DocumentationSurface}. */
interface SurfaceLike {
  id: string;
  template: string;
  triggers?: {
    keywords?: string[];
    scope?: string[];
  };
}

/**
 * One instantiated surface — a surface that fired, paired with the evidence
 * for why it fired and the files it applies to.
 *
 * @property stack the owning stack's name.
 * @property id the surface's stack-local id (not yet qualified).
 * @property templateText the surface's `template` text, copied verbatim.
 * @property triggerEvidence why the surface fired: `scopeMatched` is the files
 *   it applies to, and `keywordsHit` lists the keywords actually found (empty
 *   when the surface has no keyword triggers).
 * @property appliesToFiles the files this surface applies to; the same set as
 *   `triggerEvidence.scopeMatched`, held as an independent copy.
 */
export interface InstantiatedSurfaceRow {

  stack: string;

  id: string;

  templateText: string;

  triggerEvidence: { scopeMatched: string[]; keywordsHit: string[] };

  appliesToFiles: string[];
}

/**
 * One stack's contribution to instantiation.
 *
 * @property name the stack's name, copied onto each emitted row.
 * @property scope globs delimiting which affected files this stack governs;
 *   applied before any per-surface trigger.
 * @property surfaces the stack's surfaces (security or documentation) to test.
 */
export interface StackSurfaceInput {
  name: string;
  scope: readonly string[];
  surfaces: readonly SurfaceLike[];
}

/**
 * Instantiate every surface across every stack and return the ones that fired,
 * sorted by `(stack, id)` for determinism.
 *
 * The stack's scope is computed once per stack and reused for all its surfaces.
 * A stack with no surfaces is skipped. A surface that does not fire (see
 * {@link instantiateSurface}) contributes nothing. Pure and non-throwing.
 *
 * @param stacks per-stack name/scope/surfaces to evaluate.
 * @param affectedFiles the sprint's changed files — the candidate universe.
 * @param fileContents path → contents, consulted only for keyword triggers; a
 *   missing entry simply cannot satisfy a keyword.
 * @returns the instantiated rows, ordered by stack then id.
 */
export function instantiateSurfaces(
  stacks: readonly StackSurfaceInput[],
  affectedFiles: readonly string[],
  fileContents: Record<string, string>,
): InstantiatedSurfaceRow[] {
  const rows: InstantiatedSurfaceRow[] = [];

  for (const stack of stacks) {
    if (stack.surfaces.length === 0) continue;

    // Narrow to the stack's scope once; every surface in this stack tests
    // against the same already-scoped file set.
    const stackScopedTouched = filterByGlobs(affectedFiles, stack.scope);

    for (const surface of stack.surfaces) {
      const instantiated = instantiateSurface(
        stack.name,
        surface,
        stackScopedTouched,
        fileContents,
      );
      if (instantiated !== null) rows.push(instantiated);
    }
  }

  // Two-level sort: stack name first, surface id as tiebreaker; both use the
  // project's canonical case-sensitive, non-numeric locale comparator so the
  // ordering is reproducible across platforms.
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

/**
 * Decide whether a single surface fires for a stack and, if so, build its row.
 *
 * Returns `null` (the surface does not fire) in three cases: a `triggers.scope`
 * that matches none of the stack-scoped files; a triggerless surface when the
 * stack touched no in-scope files; or a `triggers.keywords` set where no
 * keyword appears in any candidate file's contents. Otherwise returns a fully
 * built {@link InstantiatedSurfaceRow}. Never throws.
 *
 * @param stackName owning stack, copied onto the row.
 * @param surface the surface to evaluate.
 * @param stackScopedTouched files already narrowed to the stack's scope.
 * @param fileContents path → contents for keyword matching.
 */
function instantiateSurface(
  stackName: string,
  surface: SurfaceLike,
  stackScopedTouched: readonly string[],
  fileContents: Record<string, string>,
): InstantiatedSurfaceRow | null {
  const triggers = surface.triggers ?? {};
  const triggerScope = triggers.scope ?? [];
  const triggerKeywords = triggers.keywords ?? [];

  // First gate: a surface-level scope trigger narrows the stack-scoped files
  // further. With no scope trigger, every stack-scoped file stays a candidate.
  let candidateFiles: readonly string[];
  if (triggerScope.length > 0) {
    candidateFiles = filterByGlobs(stackScopedTouched, triggerScope);
    if (candidateFiles.length === 0) return null;
  } else {

    candidateFiles = stackScopedTouched;
  }

  // A surface with no triggers at all is unconditional *except* that it still
  // needs at least one touched in-scope file to attach to — an empty change
  // set fires nothing.
  if (triggerScope.length === 0 && triggerKeywords.length === 0) {
    if (stackScopedTouched.length === 0) return null;
  }

  let keywordsHit: string[] = [];
  let scopeMatched: string[];
  if (triggerKeywords.length > 0) {
    // Keyword gate: collect every (file, keyword) co-occurrence, then derive
    // the evidence from it. Empty keywords are ignored so a stray "" cannot
    // make every file match.
    const matched: { file: string; keyword: string }[] = [];
    for (const file of candidateFiles) {
      const content = fileContents[file];
      if (typeof content !== 'string') continue;
      for (const kw of triggerKeywords) {
        if (kw.length > 0 && content.includes(kw)) {
          matched.push({ file, keyword: kw });
        }
      }
    }
    if (matched.length === 0) return null;
    // De-duplicate into the files actually hit and the keywords actually
    // found — only these become the surface's evidence, not the full
    // candidate set or the full trigger list.
    const fileSet = new Set<string>();
    const keywordSet = new Set<string>();
    for (const m of matched) {
      fileSet.add(m.file);
      keywordSet.add(m.keyword);
    }
    scopeMatched = localeSort(Array.from(fileSet));
    keywordsHit = localeSort(Array.from(keywordSet));
  } else {
    // No keyword trigger: the surface applies to every candidate file, and
    // `keywordsHit` stays empty.
    scopeMatched = localeSort([...candidateFiles]);
  }

  return {
    stack: stackName,
    id: surface.id,

    templateText: surface.template,
    triggerEvidence: { scopeMatched, keywordsHit },
    // Independent copy so a later mutation of one field cannot alias the other.
    appliesToFiles: scopeMatched.slice(),
  };
}

/**
 * Return the subset of `candidates` matching any of `patterns`, sorted.
 *
 * Each file is included at most once: the inner `break` stops at its first
 * matching pattern so overlapping globs cannot produce duplicates. An empty
 * pattern list matches nothing (returns `[]`), which is how an empty stack
 * scope short-circuits to "no candidates".
 */
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

/**
 * Sort a copy of `items` with the project's canonical comparator: locale-aware
 * but case-sensitive (`sensitivity: 'variant'`) and non-numeric, so output
 * ordering is reproducible across platforms and the caller's array is never
 * mutated in place.
 */
function localeSort(items: readonly string[]): string[] {
  const copy = items.slice();

  copy.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return copy;
}
