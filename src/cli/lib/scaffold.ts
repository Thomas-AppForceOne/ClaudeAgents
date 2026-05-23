

export { DRAFT_BANNER } from '../../config-server/scaffold-banner.js';

import { DRAFT_BANNER as BANNER } from '../../config-server/scaffold-banner.js';

const SECOND_LINE = "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

const AUDIT_STUB =
  '"false  # TODO: replace before committing — your audit command, or remove this field"';

export type ScaffoldTier = 'project' | 'user';

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
