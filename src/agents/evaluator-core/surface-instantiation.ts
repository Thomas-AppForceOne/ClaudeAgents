/**
 * Shared surface template-instantiation core (C1 protocol).
 *
 * Both `securitySurfaces` (C1) and `documentationSurfaces` (Q5 layer (c))
 * instantiate through the *identical* four-step protocol — the only
 * difference is which stack-body array supplies the surfaces and which
 * plan-output array receives the rows. To guarantee the two families
 * behave byte-for-byte the same (verbatim template, scope ∩ stack-scope
 * intersect, keyword gate, cross-contamination guard, `(stack, id)`
 * byte-stable sort), the algorithm lives here once and both
 * `security-surfaces.ts` and `documentation-surfaces.ts` delegate to it.
 *
 * Why extract rather than duplicate: Q5's spec is explicit that the
 * documentation protocol is "the identical four-step C1 protocol, no new
 * algorithm". A copy-paste of the security path would let the two drift
 * (a sort-comparator tweak applied to one and not the other would silently
 * break cross-stack determinism for the other). One implementation makes
 * the "identical protocol" guarantee structural, not a review obligation.
 *
 * The algorithm (per C1 "Template instantiation protocol", lines 188-195):
 *
 *   1. Compute the files the sprint touches (`sprintPlan.affectedFiles`).
 *   2. Intersect with the surface's `triggers.scope` globs (if present)
 *      AND the stack's own `scope` globs. If empty, skip.
 *   3. If `triggers.keywords` is present, scan the touched files'
 *      contents for any keyword. If none match, skip.
 *   4. Otherwise instantiate. Template is verbatim — no interpolation.
 *      Variable evidence (matched files, matched keywords) is recorded
 *      under `triggerEvidence`.
 *
 * Surfaces with neither trigger are instantiated unconditionally whenever
 * the stack is active and the sprint touches any file in the stack's
 * `scope`.
 *
 * Cross-contamination guard: a surface from stack A only ever sees files
 * inside stack A's `scope` (the caller intersects against `stack.scope`
 * before this module sees the candidate set), so a polyglot run never
 * applies stack A's surfaces to stack B's files.
 */

import picomatch from 'picomatch';

/**
 * Minimal structural shape both `SecuritySurface` and
 * `DocumentationSurface` satisfy. Declared locally (not imported) so this
 * module stays agnostic about *which* surface family it is instantiating —
 * it only needs an id, a verbatim template, and the optional triggers.
 */
interface SurfaceLike {
  id: string;
  template: string;
  triggers?: {
    keywords?: string[];
    scope?: string[];
  };
}

/**
 * One instantiated surface row. Shared by both the security and
 * documentation plan-output arrays (they carry the identical shape).
 */
export interface InstantiatedSurfaceRow {
  stack: string;
  id: string;
  templateText: string;
  triggerEvidence: { scopeMatched: string[]; keywordsHit: string[] };
  appliesToFiles: string[];
}

/**
 * The per-stack inputs the instantiation core needs. Decoupled from
 * `EvaluatorCoreSnapshot` so this module does not import the snapshot
 * shape and the callers (security / documentation) can pass whichever
 * surface array they own.
 *
 * @param name the active stack's name; becomes the `stack` field and the
 *   `<stack>.<id>` qualifier half. Two stacks with the same bare surface
 *   id therefore produce two distinct rows — never deduplicated.
 * @param scope the stack's own scope globs; the cross-contamination guard
 *   — candidate files are intersected against this before any surface
 *   sees them, so a surface never matches a file outside its stack.
 * @param surfaces the surface entries to instantiate for this stack
 *   (either `securitySurfaces` or `documentationSurfaces`).
 */
export interface StackSurfaceInput {
  name: string;
  scope: readonly string[];
  surfaces: readonly SurfaceLike[];
}

/**
 * Instantiate every surface across every active stack into byte-stable
 * rows, applying the shared C1 protocol.
 *
 * Each parameter:
 * @param stacks one entry per active stack carrying its name, own scope,
 *   and the surface array to instantiate. An empty `surfaces` array (or
 *   an empty `stacks` list) yields no rows for that stack.
 * @param affectedFiles the sprint's touched repo-relative paths (the
 *   planner's affected-files list); the instantiation input set.
 * @param fileContents pre-loaded UTF-8 text keyed by repo-relative path,
 *   used only for keyword matching. A path absent from this map matches
 *   no keyword (it is skipped silently), so a keyworded surface whose
 *   touched files have no loaded content emits no row — callers that need
 *   keyword gating must pre-load the relevant file bodies.
 *
 * Failure modes: this function never throws and has no side effects — it
 * is a pure mapping over its inputs. A surface that fails any gate (empty
 * scope intersection, no keyword hit) simply contributes no row rather
 * than raising. The caller relies on that purity: the evaluator plan is
 * assembled by calling this repeatedly, and a throw would abort the whole
 * plan.
 *
 * Invariant the caller relies on: the returned array is sorted by
 * `(stack, id)` and every `templateText` equals the input surface's
 * `template` byte-for-byte (no interpolation). Two stacks declaring the
 * same bare id yield two rows whose order is stable because the stack name
 * breaks the tie.
 *
 * @returns the instantiated rows, sorted by `(stack, id)`.
 */
export function instantiateSurfaces(
  stacks: readonly StackSurfaceInput[],
  affectedFiles: readonly string[],
  fileContents: Record<string, string>,
): InstantiatedSurfaceRow[] {
  const rows: InstantiatedSurfaceRow[] = [];

  for (const stack of stacks) {
    if (stack.surfaces.length === 0) continue;

    // Files the sprint touches that are also inside this stack's scope.
    // Intersecting here (before any surface runs) is the
    // cross-contamination guard: a surface can only ever see its own
    // stack's files, never another stack's in a polyglot run.
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

  // Sort by (stack, id). The (stack, id) key — not bare id — is what keeps
  // two cross-stack same-id surfaces in a deterministic order instead of
  // collapsing them; byte-stable plan output depends on this tiebreak.
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
  surface: SurfaceLike,
  stackScopedTouched: readonly string[],
  fileContents: Record<string, string>,
): InstantiatedSurfaceRow | null {
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

  // A trigger-less surface (no scope, no keywords) still requires at least
  // one touched in-scope file: the protocol fires it "whenever the sprint
  // touches any file in the stack's scope", so an empty touched set is a
  // skip, not an unconditional instantiation.
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
    // Verbatim per C1: the template is the criterion text; matched files
    // and keywords are recorded as evidence only, never substituted in.
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
      // `{ dot: true }` so dotfiles (e.g. `.env`, `.config.ts`) match the
      // same way the security path matches them — parity is required or a
      // doc surface would silently skip files the security surface catches.
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
  // `sensitivity: 'variant', numeric: false` — a fixed, locale-independent
  // ordering. The default collator is locale-sensitive and would make the
  // plan's byte output depend on the host's locale, breaking the E3
  // byte-stable-across-machines contract.
  copy.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return copy;
}
