/**
 * Shared helpers for the R6 scaffold tests — the "documented first-edit
 * pass" applied to a `buildScaffold` output, both at the parsed-body level
 * (schema/invariant unit checks) and at the text level (end-to-end
 * `validateAll`). Centralised here so `scaffold.test.ts` and
 * `scaffold-regression-guard.test.ts` (and the CLI end-to-end test) share
 * one definition instead of each carrying a copy.
 */
import { buildScaffold, DRAFT_BANNER, type ScaffoldTier } from '../../../src/cli/lib/scaffold.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

/** The scaffold's second banner line (CI warning) — removed alongside the
 * DRAFT banner during the first-edit pass. */
export const SCAFFOLD_SECOND_LINE =
  "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

/** Parse the YAML frontmatter of a scaffold (parseYamlBlock tolerates the
 * leading DRAFT banner / comment prose). */
export function scaffoldFrontmatter(text: string): Record<string, unknown> {
  const parsed = parseYamlBlock(text);
  return (parsed.data ?? {}) as Record<string, unknown>;
}

/**
 * Programmatic documented first-edit pass on the PARSED body: replace every
 * TODO-marked stub with a schema-valid value. (Banner removal is a text
 * operation, irrelevant to the parsed frontmatter; see
 * {@link applyScaffoldFirstEditText} for the full-document version.)
 */
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

/** Textually strip the DRAFT banner block (banner line + the second-line CI
 * warning that belongs to the banner block) from a scaffold, the way the
 * documented first-edit pass tells the author to. */
export function stripScaffoldBanner(text: string): string {
  return text
    .split('\n')
    .filter((l) => l !== DRAFT_BANNER && l !== SCAFFOLD_SECOND_LINE)
    .join('\n');
}

/**
 * Apply the FULL documented first-edit pass to the scaffold TEXT: remove the
 * DRAFT banner block AND replace every TODO-stub value with a schema-valid
 * one. The result is the stack file a real user would hold after following
 * the scaffold's written instructions exactly — suitable for an end-to-end
 * `validateAll` (which also runs the `stack.no_draft_banner` invariant the
 * parsed-body checks cannot exercise).
 *
 * Throws if any expected stub is missing (so a future scaffold change cannot
 * silently turn a replacement into a no-op) or if a non-comment TODO value
 * survives the pass.
 */
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
  // `# TODO:` comment lines are YAML comments and harmless to validation;
  // a TODO in a *value* line would be a real defect. Guard the latter.
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
