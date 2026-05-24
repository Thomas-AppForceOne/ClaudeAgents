/**
 * Effective-safety-config resolver — the pure function that folds the
 * framework's seed defaults, the merged overlay's `safety.*` block, and the
 * one-off runtime flags into the single effective safety config the
 * orchestrator feeds into the attempt-start checks.
 *
 * This module owns no I/O and no state: it is a pure function over plain data
 * (the seed defaults from `./loop-detection.ts` and `./sprint-budget.ts`, the
 * already-merged `safety.*` overlay block the cascade produced, and the parsed
 * runtime flags). The orchestrator resolves once at run start and threads the
 * result into `checkRoleCeiling` (the `attemptCeilings` map), `checkSprintBudget`
 * (the `sprintBudget`), and the gate on whether the edit-oscillation detector is
 * consulted (`oscillationDetection`). Keeping it pure means the precedence and
 * the `--max-attempts` arithmetic are unit-testable without an orchestrator
 * runtime, matching the other pure safety primitives.
 *
 * Precedence is flags > overlay > defaults (highest wins):
 * - Runtime flags are a one-off, deliberately coarse debugging knob a user
 *   passes for a single invocation; they beat the persisted overlay so a quick
 *   `--max-attempts=2` is not silently undercut by
 *   a project's committed `safety.*` config. The overlay, in turn, beats the
 *   framework's seed defaults.
 * - An unspecified role keeps its seed default rather than being dropped: a user
 *   raising one role's ceiling must not implicitly remove the others, so the
 *   effective map is the seed map with the overlay's (then the flag's) per-role
 *   values layered on top, never a wholesale replacement.
 */

import { DEFAULT_ATTEMPT_CEILINGS } from './loop-detection.js';
import { DEFAULT_SPRINT_BUDGET } from './sprint-budget.js';

// Role keys that must never index the effective-ceiling accumulator: they are
// the prototype-pollution vectors. Mirrors `FORBIDDEN_KEYS` in
// `src/trace/reconcile.ts` and `FORBIDDEN_ROLE_KEYS` in `./loop-detection.ts` /
// `./sprint-budget.ts`, so this resolver reuses the established guard rather than
// inventing a parallel one. A `__proto__`-named "role" reaching here from an
// overlay is hostile input, never a real configured agent.
const FORBIDDEN_ROLE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * The number of roles the `--max-attempts` flag's derived sprint budget does
 * NOT cover with its uniform per-role term, accounted for by the `+4` headroom.
 *
 * This is a **seed value, not data-derived**, consistent with the
 * {@link DEFAULT_ATTEMPT_CEILINGS} / {@link DEFAULT_SPRINT_BUDGET} seed-value
 * annotations. The derivation is `sprintBudget =
 * n × roleCount + 4`, where `roleCount` is the number of *multi-attempt* roles
 * the uniform ceiling applies to (the keys of {@link DEFAULT_ATTEMPT_CEILINGS}),
 * and the `+4` is fixed headroom for the four roles that consume attempts but
 * carry no per-role ceiling: the single-attempt clarifier and planner, plus the
 * once-per-output reviewer and evaluator. It is the same accounting as the seed
 * {@link DEFAULT_SPRINT_BUDGET} (per-role sum + headroom), expressed for an
 * arbitrary uniform ceiling `n`. A post-release audit re-tunes it against trace
 * data; until then it is an opinionated guess, and this comment is the rationale
 * a reader gets.
 */
export const MAX_ATTEMPTS_BUDGET_HEADROOM = 4;

/**
 * The fully-resolved safety config the orchestrator feeds into the attempt-start
 * checks.
 *
 * @property attemptCeilings the effective per-role ceiling map, keyed by
 *   kebab-case role id. This is exactly the table `checkRoleCeiling` consumes in
 *   place of {@link DEFAULT_ATTEMPT_CEILINGS}; every role present in the seed
 *   defaults appears here (an unspecified role keeps its seed value). Built on a
 *   null-prototype object with the forbidden-key discipline so hostile overlay
 *   role names cannot pollute it.
 * @property sprintBudget the effective sprint-wide attempt budget
 *   `checkSprintBudget` consumes in place of {@link DEFAULT_SPRINT_BUDGET}.
 * @property oscillationDetection the effective gate on whether the edit-
 *   oscillation detector is consulted: `true` (the default) ⇒ the orchestrator
 *   consults the edit-oscillation detector; `false` ⇒ it skips the detector and
 *   a generator that repeats fingerprints proceeds up to its per-role ceiling
 *   without an `editOscillation` halt. It gates the *call site*, not the
 *   detector — the safety layer never modifies agent behaviour.
 */
export interface EffectiveSafetyConfig {
  attemptCeilings: Record<string, number>;
  sprintBudget: number;
  oscillationDetection: boolean;
}

/**
 * Parsed one-off runtime flags that override the overlay for a single
 * invocation. All optional; an absent flag leaves the overlay (then the seed
 * default) in force for that dimension.
 *
 * @property maxAttempts the `--max-attempts=<n>` value: a uniform per-role
 *   ceiling applied to *every* multi-attempt role, which also derives the
 *   sprint budget as `n × roleCount + 4`. Overrides any overlay
 *   `safety.attemptCeilings` and `safety.sprintBudget`. A non-positive or
 *   non-integer value is ignored (treated as if the flag were absent) so a
 *   malformed flag degrades to the overlay/default rather than producing a
 *   zero-or-negative ceiling.
 */
export interface SafetyRuntimeFlags {
  maxAttempts?: number;
}

/**
 * The already-merged `safety.*` overlay block (the cascade's output for the
 * `safety` block) the resolver reads. All fields optional; the resolver applies
 * the seed default for any absent field.
 *
 * @property attemptCeilings the merged per-role ceiling map (role → integer),
 *   if the overlay set any ceilings.
 * @property sprintBudget the merged sprint budget, if the overlay set it.
 * @property oscillationDetection the merged oscillation gate, if the overlay set
 *   it.
 */
export interface SafetyOverlayBlock {
  attemptCeilings?: Record<string, number>;
  sprintBudget?: number;
  oscillationDetection?: boolean;
}

/**
 * Inputs to {@link resolveEffectiveSafetyConfig}.
 *
 * @property overlay the merged `safety.*` overlay block (typically
 *   `getMergedSplicePoints(...).mergedSplicePoints.safety`); omit or pass `{}`
 *   for a project that sets no safety overrides.
 * @property flags the parsed one-off runtime flags; omit when none were passed.
 * @property defaults override the seed defaults (for tests); production omits
 *   this and uses {@link DEFAULT_ATTEMPT_CEILINGS} / {@link DEFAULT_SPRINT_BUDGET}.
 */
export interface ResolveEffectiveSafetyConfigInput {
  overlay?: SafetyOverlayBlock | undefined;
  flags?: SafetyRuntimeFlags | undefined;
  defaults?:
    | { attemptCeilings?: Readonly<Record<string, number>>; sprintBudget?: number }
    | undefined;
}

// Fold a role→integer map onto a null-prototype accumulator, skipping the
// forbidden pollution keys and installing each value via Object.defineProperty
// (not assignment) so even a forbidden key reaching this point would create a
// real own property rather than walking the prototype setter. Only positive
// integers are taken; a non-positive or non-integer value is skipped so the
// accumulator never carries an invalid ceiling. Mirrors
// buildSprintBudgetEvidence's accumulator discipline in `./sprint-budget.ts`.
function foldRoleCeilings(
  target: Record<string, number>,
  source: Readonly<Record<string, number>> | undefined,
): void {
  if (source === undefined || source === null) return;
  for (const role of Object.keys(source)) {
    if (FORBIDDEN_ROLE_KEYS.has(role)) continue;
    if (!Object.prototype.hasOwnProperty.call(source, role)) continue;
    const v = source[role];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) continue;
    Object.defineProperty(target, role, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

// True for a usable `--max-attempts` value: a positive integer. A malformed
// value is treated as "flag absent" so the overlay/default still applies rather
// than the resolver emitting a zero-or-negative ceiling.
function isUsableMaxAttempts(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

/**
 * Resolve the effective safety config from seed defaults, the merged overlay's
 * `safety.*` block, and the one-off runtime flags, with precedence
 * flags > overlay > defaults.
 *
 * Behaviour, dimension by dimension:
 * - **attemptCeilings.** Starts from the seed defaults (so every seeded role is
 *   present); the overlay's per-role values are layered on top (an unspecified
 *   role keeps its seed default); then, if `--max-attempts=n` is set, a uniform
 *   ceiling of `n` is applied to *every* role the seed map carries — not just
 *   one — because the flag is a coarse "cap everything" debugging knob, and that
 *   uniform override beats any overlay per-role value.
 * - **sprintBudget.** The flag wins as `n × roleCount + 4` (roleCount = the
 *   number of seeded multi-attempt roles, the `+4` headroom for clarifier/
 *   planner/reviewer/evaluator — see {@link MAX_ATTEMPTS_BUDGET_HEADROOM});
 *   else the overlay's `sprintBudget`; else the seed default.
 * - **oscillationDetection.** The overlay's boolean if set, else the default
 *   (`true`). No runtime flag touches it. `false` is the gate the orchestrator
 *   reads to skip the oscillation detector entirely.
 *
 * @param input see {@link ResolveEffectiveSafetyConfigInput}; an empty `{}`
 *   (no overlay, no flags) yields exactly the seed defaults.
 * @returns the {@link EffectiveSafetyConfig}. Pure; never throws — malformed
 *   overlay/flag values degrade to the next-lower precedence rather than
 *   erroring (the schema already rejects mis-typed overlay values at the
 *   validation seam).
 */
export function resolveEffectiveSafetyConfig(
  input: ResolveEffectiveSafetyConfigInput = {},
): EffectiveSafetyConfig {
  const seedCeilings = input.defaults?.attemptCeilings ?? DEFAULT_ATTEMPT_CEILINGS;
  const seedBudget = input.defaults?.sprintBudget ?? DEFAULT_SPRINT_BUDGET;
  const overlay = input.overlay ?? {};
  const flags = input.flags ?? {};

  // Build the effective ceiling map on a null-prototype accumulator: seed first
  // (so every seeded role is present and an unspecified role keeps its default),
  // then the overlay layered on top. The accumulator + forbidden-key skip +
  // defineProperty install is the same prototype-pollution discipline
  // buildSprintBudgetEvidence uses, reused rather than re-invented.
  const attemptCeilings: Record<string, number> = Object.create(null) as Record<string, number>;
  foldRoleCeilings(attemptCeilings, seedCeilings);
  foldRoleCeilings(attemptCeilings, overlay.attemptCeilings);

  // roleCount is the number of *multi-attempt* roles the uniform flag ceiling
  // targets — exactly the seed map's key set, NOT the post-overlay map (the
  // overlay must not change how many roles the +4 derivation accounts for).
  const roleCount = Object.keys(seedCeilings).length;

  let sprintBudget: number;
  const maxAttempts = flags.maxAttempts;
  if (isUsableMaxAttempts(maxAttempts)) {
    // Flag wins, and it OVERRIDES the overlay: a uniform ceiling of n on every
    // multi-attempt role, plus the derived budget. Re-applied after the overlay
    // fold so a conflicting overlay per-role ceiling (e.g. gan-generator: 5) is
    // beaten by the flag's uniform n.
    for (const role of Object.keys(attemptCeilings)) {
      Object.defineProperty(attemptCeilings, role, {
        value: maxAttempts,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    sprintBudget = maxAttempts * roleCount + MAX_ATTEMPTS_BUDGET_HEADROOM;
  } else if (typeof overlay.sprintBudget === 'number' && Number.isInteger(overlay.sprintBudget) && overlay.sprintBudget >= 1) {
    sprintBudget = overlay.sprintBudget;
  } else {
    sprintBudget = seedBudget;
  }

  // oscillationDetection: only the overlay can flip it (no runtime flag); an
  // absent or non-boolean overlay value falls through to the default (true).
  const oscillationDetection =
    typeof overlay.oscillationDetection === 'boolean' ? overlay.oscillationDetection : true;

  return { attemptCeilings, sprintBudget, oscillationDetection };
}

/**
 * Read the merged `safety.*` overlay block out of a merged splice-point map
 * into the {@link SafetyOverlayBlock} the resolver consumes, defensively
 * narrowing each field so a malformed merged value degrades to "absent" rather
 * than propagating.
 *
 * @param merged the merged splice-point map (e.g.
 *   `getMergedSplicePoints(...).mergedSplicePoints`), or any value — a non-object
 *   yields an empty block.
 * @returns a {@link SafetyOverlayBlock}; fields are present only when the merged
 *   overlay carried a well-typed value for them. Pure; never throws.
 */
export function readSafetyOverlayBlock(merged: unknown): SafetyOverlayBlock {
  const block: SafetyOverlayBlock = {};
  if (typeof merged !== 'object' || merged === null || Array.isArray(merged)) return block;
  const safety = (merged as Record<string, unknown>)['safety'];
  if (typeof safety !== 'object' || safety === null || Array.isArray(safety)) return block;
  const s = safety as Record<string, unknown>;

  const ceilings = s['attemptCeilings'];
  if (typeof ceilings === 'object' && ceilings !== null && !Array.isArray(ceilings)) {
    // Narrow to a role→integer map; the resolver's foldRoleCeilings re-validates
    // each value, but copying only integer values here keeps the type honest.
    const out: Record<string, number> = {};
    for (const role of Object.keys(ceilings as Record<string, unknown>)) {
      const v = (ceilings as Record<string, unknown>)[role];
      if (typeof v === 'number' && Number.isInteger(v)) out[role] = v;
    }
    block.attemptCeilings = out;
  }

  const budget = s['sprintBudget'];
  if (typeof budget === 'number' && Number.isInteger(budget)) block.sprintBudget = budget;

  const osc = s['oscillationDetection'];
  if (typeof osc === 'boolean') block.oscillationDetection = osc;

  return block;
}
