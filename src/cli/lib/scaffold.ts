/**
 * R3 sprint 4 — `gan stacks new` scaffold builder.
 *
 * Pure function: takes a stack name, returns the verbatim text of the
 * scaffold file. The file shape is locked by the R3 spec's
 * "Scaffold contract" example:
 *
 *   1. The DRAFT banner (first non-blank line). Imported from
 *      `scaffold-banner.ts` so there's only one canonical literal in `src/`
 *      (per the scaffold-banner verbatim rule, PROJECT_CONTEXT.md).
 *   2. A second non-blank comment line warning that `gan validate` and the
 *      maintainer's `lint-stacks` CI gate fail while the banner is present.
 *   3. A YAML frontmatter block delimited by `---` lines (matching R1's
 *      `parseYamlBlock` contract): `name`, `schemaVersion`, plus
 *      TODO-stubbed fields for `detection`, `scope`, `secretsGlob`,
 *      `auditCmd`, `buildCmd`, `testCmd`, `lintCmd`, `securitySurfaces`.
 *   4. A trailing prose section starting with `## Conventions`.
 *   5. A single trailing newline.
 *
 * The scaffold deliberately writes TODO placeholders only — no host-repo
 * inspection or detection inference (the no-detection-inference rule).
 * The TODO placeholders intentionally produce schema-violating values so
 * `gan validate` rejects the file twice over (DRAFT-banner invariant
 * fires hard; schema fails on the placeholder shapes); the user replaces
 * them in their first edit pass.
 *
 * Re-exports `DRAFT_BANNER` so other modules in `src/cli/` can import the
 * banner from one canonical CLI location without re-declaration. The
 * underlying constant lives in `src/config-server/scaffold-banner.ts`;
 * this is the same identity (same module-scoped binding), not a copy.
 */

export { DRAFT_BANNER } from '../../config-server/scaffold-banner.js';

import { DRAFT_BANNER as BANNER } from '../../config-server/scaffold-banner.js';

const SECOND_LINE = "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

const AUDIT_STUB =
  '"false  # TODO: replace before committing — your audit command, or remove this field"';

/**
 * The tiers `gan stacks new` can scaffold to. Per C5 the only end-user
 * scaffold targets are `project` (default) and `user`; `builtin` ships in
 * the npm package and is surfaced via `gan stacks customize`, so it is not
 * a `buildScaffold` tier. R6 makes both tiers emit the same detection-free
 * body; the only wording difference is the overlay named in the
 * `stack.override` activation hint.
 */
export type ScaffoldTier = 'project' | 'user';

/**
 * The detection-shaped comment block R6 emits in place of a `detection:`
 * block at project/user tier.
 *
 * Per C5 ("detection rules live only in the builtin tier") and the F3
 * cross-file invariant `detection.tier3_only`, a `detection` block in a
 * project- or user-tier stack file is a hard `InvariantViolation` (and C1
 * rejects it at parse time). The old scaffold told the author to fill in a
 * `detection:` block they could never make valid at this tier. R6 removes
 * the block entirely and replaces it with this guidance at the exact spot
 * the author would otherwise have typed the doomed block — naming both
 * activation paths, the `stack.override` overlay field, and the wholesale
 * (non-additive) nature of the override (wording deliberately aligned with
 * W1's `StackOverrideShrinkage` remediation).
 *
 * The body is byte-identical between `project` and `user` except for the
 * overlay named in the `stack.override` hint.
 */
function activationComment(tier: ScaffoldTier): string[] {
  const overlayPhrase =
    tier === 'project'
      ? 'your project overlay (.claude/gan/project.md)'
      : 'your user overlay (~/.claude/gan/user.md)';
  const tierWord = tier === 'project' ? 'project-tier' : 'user-tier';
  return [
    `# This stack is ${tierWord}: it cannot declare \`detection:\` (that is`,
    '# builtin-tier only — see C5 / F3 detection.tier3_only). It activates by',
    '# EITHER naming a builtin stack (same `name:` shadows/replaces it when that',
    "# stack's detection fires) OR being forced via `stack.override` in",
    `# ${overlayPhrase}. Without one of those, this`,
    '# stack never becomes active. `stack.override` REPLACES auto-detection',
    '# wholesale — it is not additive. If you list only this stack you suppress',
    '# every detected stack and the `generic` fallback; list `generic` and any',
    '# other stack you want to keep alongside this one.',
  ];
}

/**
 * Build the scaffold text for a stack named `name` at tier `tier`.
 *
 * The function is pure: same `(name, tier)` ⇒ byte-identical output across
 * runs (no host-repo inspection, no I/O, no nondeterministic input).
 * Callers (`gan stacks new`) write the result via `atomicWriteFile`.
 *
 * Tier→body selection is centralised here behind the single `tier`
 * argument — call sites do not branch on tier. For both `project` and
 * `user` the emitted body contains NO `detection:` block; in its place is
 * the {@link activationComment} explaining how the stack activates at this
 * tier. Every other stubbed field (name, schemaVersion, scope, buildCmd,
 * testCmd, lintCmd, auditCmd, secretsGlob, securitySurfaces), the DRAFT
 * banner, the second-line CI warning, and the `## Conventions` prose are
 * unchanged from the pre-R6 scaffold. `scope` stays a TODO stub: it is
 * valid at project/user tier (only `detection` is `tier3_only`) and a
 * forked stack still needs its scope declared.
 *
 * Layout:
 *
 *   <BANNER>
 *   <SECOND_LINE>
 *
 *   ---
 *   schemaVersion: 1
 *   name: <name>
 *   <activation comment — no detection: block>
 *   ... TODO-stubbed fields ...
 *   ---
 *
 *   ## Conventions
 *
 *   ... TODO-stubbed prose ...
 */
export function buildScaffold(name: string, tier: ScaffoldTier = 'project'): string {
  const lines: string[] = [];
  lines.push(BANNER);
  lines.push(SECOND_LINE);
  lines.push('');
  lines.push('---');
  lines.push('schemaVersion: 1');
  lines.push(`name: ${name}`);
  for (const commentLine of activationComment(tier)) {
    lines.push(commentLine);
  }
  lines.push('# TODO: replace the scope globs so stack-scoped commands run only on');
  lines.push('# files this ecosystem owns.');
  lines.push('scope:');
  lines.push('  - "TODO/**/*"');
  lines.push('# TODO: replace each command stub with the real one for this ecosystem.');
  lines.push('buildCmd: "false  # TODO: replace before committing — your build command"');
  lines.push('testCmd: "false  # TODO: replace before committing — your test command"');
  lines.push('lintCmd: "false  # TODO: replace before committing — your lint command"');
  lines.push(`auditCmd: ${AUDIT_STUB}`);
  lines.push('# TODO: list secret-bearing globs so the framework can warn before commits.');
  lines.push('secretsGlob:');
  lines.push('  - "TODO-replace-with-a-real-glob"');
  lines.push(
    '# TODO: declare the security surfaces this ecosystem exposes (one entry per surface).',
  );
  lines.push('securitySurfaces: []');
  lines.push('---');
  lines.push('');
  lines.push('## Conventions');
  lines.push('');
  lines.push(
    'Replace this prose section with a short description of the conventions a contributor',
  );
  lines.push(
    'should follow when working on this stack. Cover idiomatic patterns, common pitfalls,',
  );
  lines.push('and any house style the team enforces.');
  lines.push('');
  return lines.join('\n');
}
