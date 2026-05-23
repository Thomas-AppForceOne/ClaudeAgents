

/**
 * Builder for the text of a freshly scaffolded stack file (`gan stacks new`,
 * and the customize/reset flows that seed a starter file).
 *
 * The output is a YAML-front-matter stack document deliberately full of `TODO`
 * stubs and a draft banner: it is meant to fail `gan validate` and the
 * lint-stacks check until a human fills it in, which is how the framework
 * stops an unedited scaffold from being committed. Everything here is string
 * assembly — no I/O — so the result is easy to test and the caller owns where
 * (and whether) it lands on disk.
 */

// Re-exported so callers needing the banner text don't have to reach into the
// config-server package directly; this module is their single stack-scaffold
// surface.
export { DRAFT_BANNER } from '../../config-server/scaffold-banner.js';

import { DRAFT_BANNER as BANNER } from '../../config-server/scaffold-banner.js';

// Second line of the banner, paired with DRAFT_BANNER above it. Its `#`-prefixed
// text is YAML/markdown comment content emitted *into the generated file*, not a
// TypeScript comment — it is the warning a contributor sees and must remove.
const SECOND_LINE = "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

// The auditCmd field value: a quoted YAML string whose own `#` comment tells the
// contributor to replace or delete the field. `false` is a safe inert default
// (the command "fails") so an unedited scaffold cannot silently pass an audit.
const AUDIT_STUB =
  '"false  # TODO: replace before committing — your audit command, or remove this field"';

/**
 * Which writable tier a scaffolded stack targets: the project overlay or the
 * user overlay. Drives the activation guidance baked into the file (see
 * {@link activationComment}).
 */
export type ScaffoldTier = 'project' | 'user';

// Builds the block of YAML comment lines (each a literal `#`-prefixed string)
// that explain how a non-builtin, tier-specific stack becomes active. The
// wording differs only in naming the project vs. user overlay; the rule it
// documents (activate by shadowing a builtin name or via stack.override, and
// that override replaces detection wholesale) is the same for both tiers.
function activationComment(tier: ScaffoldTier): string[] {
  const overlayPhrase =
    tier === 'project'
      ? 'project overlay (.claude/gan/project.md)'
      : 'user overlay (~/.claude/gan/user.md)';
  const tierWord = tier === 'project' ? 'project-tier' : 'user-tier';
  return [
    `# This stack is ${tierWord}: it cannot declare \`detection:\` (that is`,
    '# builtin-tier only — see C5 / F3 detection.tier3_only). It activates by',
    '# EITHER naming a builtin stack (same `name:` shadows/replaces it when that',
    "# stack's detection fires) OR being forced via `stack.override` in your",
    `# ${overlayPhrase}. Without one of those, this`,
    '# stack never becomes active. `stack.override` REPLACES auto-detection',
    '# wholesale — it is not additive. If you list only this stack you suppress',
    '# every detected stack and the `generic` fallback; list `generic` and any',
    '# other stack you want to keep alongside this one.',
  ];
}

/**
 * Build the full text of a starter stack file for `name`.
 *
 * The document is assembled line by line: the draft banner, the YAML front
 * matter (`schemaVersion`, `name`, the tier-specific activation comment, and
 * `TODO`-stubbed `scope`/`buildCmd`/`testCmd`/`lintCmd`/`auditCmd`/
 * `secretsGlob`/`securitySurfaces`), then a prose `## Conventions` section to
 * be replaced. Every command stub defaults to `false`, so an unedited scaffold
 * fails validation rather than silently "passing".
 *
 * @param name the stack name; written verbatim into the `name:` field.
 * @param tier which writable tier the file targets (default `project`); only
 *   affects the activation-guidance comment, not the field stubs.
 * @returns the complete file contents as a single string (newline-joined, no
 *   trailing newline beyond the final blank line). Pure — performs no I/O.
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
