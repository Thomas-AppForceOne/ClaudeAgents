/**
 * Detect overlay declarations the framework accepts but does not act on the way
 * the user likely intended, and turn each into a non-aborting {@link Warning}.
 *
 * One surface lives here, pure (no I/O, no logging, no throw):
 *
 * {@link computeStackOverrideShrinkageWarning} — `stack.override` replaces
 * auto-detection wholesale (the detection contract), so an override authored to
 * *add* a stack silently *drops* every stack detection would have activated. The
 * resolver runs detection a second time even though the override short-circuits
 * it, so this function can compare the two sets and flag genuine coverage loss.
 */

import { localeSort } from '../determinism/index.js';
import { createWarning, type Warning } from '../warnings.js';

// The framework's fallback stack name. Auto-detection falls back to this when
// no real stack matches, so the absence of a recognized ecosystem still leaves
// a project with working defaults. Named once here so the shrinkage edge case
// (an override that excludes the fallback) reads against a single constant.
const FALLBACK_STACK = 'generic';

/**
 * Inputs for the `stack.override` shrinkage check, all pre-computed by the
 * resolver (which is the only layer that can cheaply run detection a second
 * time and read the cascaded override).
 *
 * @property overrideActive the active stack names the user's non-empty
 *   `stack.override` produced. Empty ⇒ no override was in force, so no warning.
 * @property detectionActive the active stack names auto-detection would have
 *   produced had the override been absent (the resolver runs detection anyway
 *   to obtain this). When detection matched nothing, this is the fallback set
 *   (`[generic]`), matching detection's real behaviour.
 * @property detectionFellBackToGeneric whether `detectionActive` is the
 *   fallback (`generic`) because no real stack matched, as opposed to a genuine
 *   one-stack detection. The count comparison cannot distinguish these, so the
 *   resolver passes the flag explicitly.
 */
export interface ShrinkageInput {
  overrideActive: string[];
  detectionActive: string[];
  detectionFellBackToGeneric: boolean;
}

/**
 * Decide whether a non-empty `stack.override` lost coverage relative to what
 * auto-detection would have activated, and build the warning if so.
 *
 * @param input pre-computed override/detection sets; see {@link ShrinkageInput}.
 * @returns a single {@link StackOverrideShrinkage} {@link Warning}, or `null`
 *   when no coverage was lost. Pure: no I/O, never throws.
 *
 * Two distinct loss conditions, in priority order:
 *
 *   1. **Fallback loss (the count-blind edge case).** When detection would have
 *      fallen back to `generic` and the override excludes `generic`, the user
 *      lost the framework's fallback semantics even though both sets may be the
 *      same size (override `[x]` vs fallback `[generic]`, each size 1). A raw
 *      size comparison misses this, so it gets its own branch and prose.
 *
 *   2. **Strict shrinkage.** Otherwise the override loses coverage only when
 *      the set of stacks it suppressed (in detection but not in the override)
 *      is non-empty AND the override is strictly smaller than detection. The
 *      size guard is what excludes a same-size *swap* (the user replaced one
 *      detected stack with their own choice — deliberate, not a loss) from
 *      firing the warning.
 */
export function computeStackOverrideShrinkageWarning(input: ShrinkageInput): Warning | null {
  const overrideSet = localeSort(input.overrideActive.slice());
  // An empty override means auto-detection was in force; there is nothing to
  // compare against, so the shrinkage surface does not apply.
  if (overrideSet.length === 0) return null;

  const detectionSet = localeSort(input.detectionActive.slice());

  // Branch 1 — fallback loss. Detection falling back to `generic` is a coverage
  // guarantee, not a stack the user chose; excluding it drops that guarantee
  // regardless of set sizes, so it is checked before the size-based branch.
  if (input.detectionFellBackToGeneric && !overrideSet.includes(FALLBACK_STACK)) {
    return createWarning(
      {
        code: 'StackOverrideShrinkage',
        overrideSet,
        detectionSet,
        suppressed: [FALLBACK_STACK],
      },
      shrinkageGenericFallbackMessage(overrideSet),
    );
  }

  // Branch 2 — strict shrinkage. `suppressed` is the coverage the override
  // dropped; the strict size guard excludes a same-size swap (a deliberate
  // replacement loses no coverage the user expected).
  const overridePresent = new Set(overrideSet);
  const suppressed = detectionSet.filter((name) => !overridePresent.has(name));
  if (suppressed.length > 0 && overrideSet.length < detectionSet.length) {
    return createWarning(
      {
        code: 'StackOverrideShrinkage',
        overrideSet,
        detectionSet,
        suppressed,
      },
      shrinkageMessage(overrideSet, detectionSet, suppressed),
    );
  }

  return null;
}

/**
 * Compose every overlay warning for one resolution.
 *
 * Currently a single source — the (optional) `stack.override` shrinkage warning
 * — wrapped in a list so the composition seam stays stable: a future overlay
 * warning is added here without changing the resolver's call site.
 *
 * @param shrinkage pre-computed shrinkage inputs from the resolver.
 * @returns the {@link Warning} list — the shrinkage warning when coverage was
 *   lost, otherwise empty. Pure: never throws.
 */
export function computeOverlayWarnings(shrinkage: ShrinkageInput): Warning[] {
  const out: Warning[] = [];
  const shrink = computeStackOverrideShrinkageWarning(shrinkage);
  if (shrink) out.push(shrink);
  return out;
}

// Render the standard shrinkage prose. It names the user's exact override set
// and the detection set (so they can find and edit the declaration), states
// what was suppressed, and gives the concrete remediation — the verbose,
// teaching tone is intentional because the behaviour (override replaces, not
// adds) is unintuitive on first encounter.
function shrinkageMessage(
  overrideSet: string[],
  detectionSet: string[],
  suppressed: string[],
): string {
  const kept = list(overrideSet);
  const full = list([...overrideSet, ...suppressed]);
  return (
    `Your overlay's \`stack.override\` set ${bracket(overrideSet)} is smaller than the ` +
    `auto-detection result ${bracket(detectionSet)}. Stacks suppressed by your override: ` +
    `${bracket(suppressed)}. If you want to KEEP the suppressed stacks alongside ${kept}, ` +
    `list them in \`stack.override\`: \`[${full}]\`. \`stack.override\` is a replacement, ` +
    `not an addition.`
  );
}

// Render the fallback-loss prose. This is the count-blind edge case (override
// and fallback can both be one stack), so the prose explains the loss of
// fallback SEMANTICS rather than a size comparison, and names the remediation
// of adding the fallback stack back into the override.
function shrinkageGenericFallbackMessage(overrideSet: string[]): string {
  const kept = list(overrideSet);
  return (
    `Your overlay's \`stack.override\` excludes \`${FALLBACK_STACK}\`, the framework's ` +
    `fallback stack for projects without a recognized ecosystem. Without \`${FALLBACK_STACK}\`, ` +
    `no fallback semantics apply for files outside ${bracket(overrideSet)}'s scope. If you ` +
    `want fallback semantics, include \`${FALLBACK_STACK}\` in \`stack.override\`: ` +
    `\`[${kept}, ${FALLBACK_STACK}]\`.`
  );
}

// Join names into a backtick-wrapped, comma-separated list for embedding inside
// the bracketed `[ ... ]` form the prose uses, e.g. `a`, `b`.
function list(names: string[]): string {
  return names.map((n) => `\`${n}\``).join(', ');
}

// Wrap a name list as the bracketed display form the warning prose uses
// throughout, e.g. [`a`, `b`].
function bracket(names: string[]): string {
  return `[${list(names)}]`;
}
