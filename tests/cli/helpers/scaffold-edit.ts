
import { buildScaffold, DRAFT_BANNER, type ScaffoldTier } from '../../../src/cli/lib/scaffold.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

export const SCAFFOLD_SECOND_LINE =
  "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

export function scaffoldFrontmatter(text: string): Record<string, unknown> {
  const parsed = parseYamlBlock(text);
  return (parsed.data ?? {}) as Record<string, unknown>;
}

export function editedScaffoldBody(
  name: string,
  tier: ScaffoldTier,
): Record<string, unknown> {
  const body = scaffoldFrontmatter(buildScaffold(name, tier));
  return {
    ...body,
    scope: ['src/**/*'],
    buildCmd: 'echo build',
    testCmd: 'echo test',
    lintCmd: 'echo lint',
    auditCmd: { command: 'echo audit', absenceSignal: 'silent' },
    secretsGlob: ['**/*.pem'],
    securitySurfaces: [],
  };
}

export function stripScaffoldBanner(text: string): string {
  return text
    .split('\n')
    .filter((l) => l !== DRAFT_BANNER && l !== SCAFFOLD_SECOND_LINE)
    .join('\n');
}

export function applyScaffoldFirstEditText(scaffoldText: string): string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ['scope:\n  - "TODO/**/*"', 'scope:\n  - "src/**/*"'],
    [
      'buildCmd: "false  # TODO: replace before committing — your build command"',
      'buildCmd: "echo build"',
    ],
    [
      'testCmd: "false  # TODO: replace before committing — your test command"',
      'testCmd: "echo test"',
    ],
    [
      'lintCmd: "false  # TODO: replace before committing — your lint command"',
      'lintCmd: "echo lint"',
    ],
    [
      'auditCmd: "false  # TODO: replace before committing — your audit command, or remove this field"',
      'auditCmd:\n  command: "echo audit"\n  absenceSignal: "silent"',
    ],
    [
      'secretsGlob:\n  - "TODO-replace-with-a-real-glob"',
      'secretsGlob:\n  - "**/*.pem"',
    ],
  ];
  let out = stripScaffoldBanner(scaffoldText);
  for (const [from, to] of replacements) {
    if (!out.includes(from)) {
      throw new Error(
        `scaffold first-edit pass: expected stub not found: ${JSON.stringify(from)}`,
      );
    }
    out = out.replace(from, to);
  }

  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.includes('TODO')) {
      throw new Error(
        `scaffold first-edit pass: residual TODO value: ${JSON.stringify(line)}`,
      );
    }
  }
  return out;
}
