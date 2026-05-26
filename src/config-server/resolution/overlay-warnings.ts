/**
 * Detect overlay declarations the framework accepts but does not act on the way
 * the user likely intended, and turn each into a non-aborting {@link Warning}.
 *
 * Two independent surfaces live here, both pure (no I/O, no logging, no throw):
 *
 * 1. {@link computeStackOverrideShrinkageWarning} — `stack.override` replaces
 *    auto-detection wholesale (the detection contract), so an override authored
 *    to *add* a stack silently *drops* every stack detection would have
 *    activated. The resolver runs detection a second time even though the
 *    override short-circuits it, so this function can compare the two sets and
 *    flag genuine coverage loss.
 *
 * 2. {@link computePerStackOverrideWarnings} — a per-stack command override
 *    (`<stack>.auditCmd` / `buildCmd` / `testCmd` / `lintCmd`) is accepted by
 *    the overlay schema but not yet applied, so it is recorded and ignored.
 *
 * Both are best-effort over user-controlled input: the per-stack scan walks
 * arbitrary stack-name keys from the merged overlay, so it guards against
 * prototype-polluting keys and non-object entries and tolerates any malformed
 * shape without throwing. A security invariant binds the per-stack surface: the
 * override *value* is opaque user text that may embed a secret, so it is never
 * read into a warning's message or details — only the stack name and the set of
 * overridden field names are surfaced.
 */

import { localeSort } from '../determinism/index.js';
import { createWarning, WARNING_FIELD_ORDER, type Warning } from '../warnings.js';

// The framework's fallback stack name. Auto-detection falls back to this when
// no real stack matches, so the absence of a recognized ecosystem still leaves
// a project with working defaults. Named once here so the shrinkage edge case
// (an override that excludes the fallback) reads against a single constant.
const FALLBACK_STACK = 'generic';

// Object keys that must never be used to index a user-controlled map: they are
// the prototype-pollution vectors. The per-stack scan iterates stack-name keys
// straight from the merged overlay, which is user-authored, so a key spelled
// `__proto__`/`constructor`/`prototype` is hostile input, never a real stack
// name, and is skipped. Mirrors the FORBIDDEN_ROLE_KEYS guard the overlay
// cascade uses for the same reason, so this scan cannot regress that boundary.
const FORBIDDEN_STACK_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

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
 * Scan an overlay body for per-stack command overrides and emit one warning per
 * stack that declares any.
 *
 * @param overlaySource the overlay body to scan: a `<stack-name> → { auditCmd?,
 *   buildCmd?, testCmd?, lintCmd? }` shape. This is the user's authored overlay
 *   (where a stack-named block survives), not the cascade's allowlisted `merged`
 *   output. User-authored, so its keys and values are untrusted.
 * @returns a {@link Warning} array, one {@link PerStackOverrideUnsupported}
 *   entry per stack with at least one overridden command field, locale-sorted
 *   by stack name for byte-stable output. Empty when none apply. Pure: no I/O,
 *   never throws on any malformed shape.
 *
 * Emission rule: multiple overridden fields for the *same* stack collapse into
 * one warning whose field set is ordered by {@link WARNING_FIELD_ORDER} (a
 * fixed order, so the snapshot bytes do not depend on user declaration order);
 * distinct stacks each get their own warning. The warning fires whether or not
 * the stack is active — the user's intent was likely a future-run override.
 *
 * Security invariant: only the stack name and the overridden field names reach
 * the warning. The override *value* (e.g. `web-node.buildCmd`'s command string,
 * which may carry a secret) is never read, interpreted, or copied anywhere — it
 * stays opaque user text. This is load-bearing because the snapshot is
 * persisted and the startup log echoes warnings.
 *
 * Prototype-pollution safety: stack-name keys come straight from user input, so
 * `__proto__`/`constructor`/`prototype` keys are skipped and every keyed access
 * uses an own-property check, so the scan never reads through the prototype
 * chain or treats an inherited property as a declared override.
 */
export function computePerStackOverrideWarnings(overlaySource: unknown): Warning[] {
  if (!isObject(overlaySource)) return [];

  // The overlay's framework blocks (`stack`, `proposer`, `planner`,
  // `generator`, `evaluator`, `runner`, `safety`, `clarifier`, `telemetry`) are
  // not stack names. A per-stack command override lives under a top-level key
  // that IS a stack name (e.g. `web-node`), so the framework blocks are excluded
  // from the stack-name scan or they would be mis-read as stacks. Listing them
  // here keeps the scan robust even though none of them currently carries a
  // command-field-shaped value.
  const reservedBlocks = new Set([
    'stack',
    'proposer',
    'planner',
    'generator',
    'evaluator',
    'runner',
    'safety',
    'clarifier',
    'telemetry',
  ]);

  const warnings: Warning[] = [];
  // Object.keys returns only own enumerable keys, so an inherited property
  // cannot enter the loop; the forbidden-key skip below additionally drops a
  // hostile own key spelled like a prototype member.
  for (const stackName of localeSort(Object.keys(overlaySource))) {
    if (FORBIDDEN_STACK_KEYS.has(stackName)) continue;
    if (reservedBlocks.has(stackName)) continue;

    const entry = readOwn(overlaySource, stackName);
    // A stack entry must be an object to carry command fields; a non-object
    // (string, array, null) is a malformed shape and is tolerated by skipping.
    if (!isObject(entry)) continue;

    const fields: string[] = [];
    // Iterate the canonical field order, not the entry's keys, so the emitted
    // field set is deterministically ordered regardless of how the user wrote
    // it. Only the field NAME is recorded — the value is never read.
    for (const field of WARNING_FIELD_ORDER) {
      if (hasOwn(entry, field)) fields.push(field);
    }
    if (fields.length === 0) continue;

    warnings.push(
      createWarning(
        { code: 'PerStackOverrideUnsupported', stack: stackName, fields },
        perStackOverrideMessage(stackName, fields),
      ),
    );
  }
  return warnings;
}

/**
 * Compose every overlay warning for one resolution: the (optional) shrinkage
 * warning followed by the per-stack-override warnings.
 *
 * @param shrinkage pre-computed shrinkage inputs from the resolver.
 * @param overlaySource the overlay body to scan for per-stack command-override
 *   blocks. This is the user's declared overlay shape (a stack-name → fields
 *   map can appear here), NOT the cascade's `merged` output — the cascade only
 *   retains its allowlisted splice points and would strip a stack-named block,
 *   yet the user's intent (and the declaration they need to find and edit) lives
 *   in their authored overlay. Caller passes the source that preserves it.
 * @returns the combined {@link Warning} list, shrinkage first (when present)
 *   then the locale-sorted per-stack warnings. The two surfaces are independent
 *   and compose without interaction. Pure: never throws.
 */
export function computeOverlayWarnings(
  shrinkage: ShrinkageInput,
  overlaySource: unknown,
): Warning[] {
  const out: Warning[] = [];
  const shrink = computeStackOverrideShrinkageWarning(shrinkage);
  if (shrink) out.push(shrink);
  out.push(...computePerStackOverrideWarnings(overlaySource));
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

// Render the per-stack-override prose. It names the user's exact stack and the
// overridden field set so they can find and edit the declaration, explains that
// the override was accepted but is not yet applied (recorded, no effect this
// run), and gives the remediation. It deliberately never includes the override
// VALUE — only the field names — so a value carrying a secret cannot leak into
// the persisted snapshot or the startup log via this string.
function perStackOverrideMessage(stack: string, fields: string[]): string {
  return (
    `Your overlay declares per-stack command overrides for stack \`${stack}\` ` +
    `(fields: ${bracket(fields)}). Per-stack command overrides are not yet applied by the ` +
    `framework, so your override is recorded but will not affect this run — the run uses the ` +
    `stack-file defaults instead. To run with only the stack-file defaults and silence this ` +
    `warning, remove the per-stack command overrides from your overlay.`
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

// Own-property read that never traverses the prototype chain: returns the
// value only when the key is the object's own property, else undefined. Used
// for every access into the user-controlled overlay so an inherited member
// cannot masquerade as a declared field.
function readOwn(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// Own-property presence check (no prototype-chain traversal). A field declared
// via the prototype must not count as a user override.
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Local plain-object guard: true only for a non-null, non-array object.
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
