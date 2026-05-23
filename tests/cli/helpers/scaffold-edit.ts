/**
 * Test helpers for simulating the human edits a user makes to a freshly
 * scaffolded stack file.
 *
 * A `gan stacks scaffold` output ships with a DRAFT banner and `TODO`-stubbed
 * fields that intentionally fail validation until a human fills them in. These
 * helpers reproduce that "edit the stub into a valid stack" step in two forms:
 * a parsed-object form ({@link editedScaffoldBody}) and a textual find/replace
 * form ({@link applyScaffoldFirstEditText}) that mirrors what a user would type
 * by hand — so tests can assert the scaffold-then-edit round-trip validates.
 */

import { buildScaffold, DRAFT_BANNER, type ScaffoldTier } from '../../../src/cli/lib/scaffold.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

// The second comment line of the scaffold banner. Together with DRAFT_BANNER it
// is what stripScaffoldBanner removes; held here as the single source of truth
// so the strip logic and the banner stay in lockstep.
export const SCAFFOLD_SECOND_LINE =
  "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

/**
 * Parse a stack file's YAML front-matter into a plain object.
 *
 * @param text the full scaffold/stack file source.
 * @returns the parsed front-matter mapping, or `{}` when the block has no body.
 */
export function scaffoldFrontmatter(text: string): Record<string, unknown> {
  const parsed = parseYamlBlock(text);
  return (parsed.data ?? {}) as Record<string, unknown>;
}

/**
 * Build the object form of a scaffold that has been edited into a valid stack:
 * the scaffold's own front-matter with every `TODO` stub overwritten by
 * concrete, schema-valid values. Useful for tests that compare against an
 * expected post-edit object without driving the textual edit path.
 *
 * @param name stack name fed to {@link buildScaffold}.
 * @param tier scaffold tier (controls which fields the scaffold emits).
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

/**
 * Remove the two-line DRAFT banner from scaffold text, leaving the rest of the
 * file (including its real comments) intact. Matches whole lines exactly so a
 * line that merely contains the banner text is not accidentally dropped.
 */
export function stripScaffoldBanner(text: string): string {
  return text
    .split('\n')
    .filter((l) => l !== DRAFT_BANNER && l !== SCAFFOLD_SECOND_LINE)
    .join('\n');
}

/**
 * Apply the textual "first edit" pass to a raw scaffold: strip the banner and
 * substitute each `TODO`-stubbed field for a concrete value, mimicking a user
 * editing the file by hand.
 *
 * Two guards make this strict rather than best-effort:
 * - every expected stub MUST be present (a missing stub throws), so a drift in
 *   the scaffold template surfaces here instead of silently producing
 *   half-edited output;
 * - after substitution, no non-comment line may still contain `TODO` (a
 *   residual stub also throws), proving the edit pass left a fully valid stack.
 *
 * @param scaffoldText raw output of `buildScaffold` / `gan stacks scaffold`.
 * @returns the edited, banner-free, TODO-free stack source.
 * @throws Error if an expected stub is absent or a residual `TODO` value remains.
 */
export function applyScaffoldFirstEditText(scaffoldText: string): string {
  // Ordered [from, to] pairs. The `from` strings are the literal scaffold stubs
  // (YAML fragments, including their inline `# TODO` comments) and the `to`
  // strings are the concrete replacements — both are DATA, not code comments.
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
    // Fail loudly if the template drifted: a stub we expected to replace is
    // gone, so the rest of the pass would silently leave a stale/invalid field.
    if (!out.includes(from)) {
      throw new Error(
        `scaffold first-edit pass: expected stub not found: ${JSON.stringify(from)}`,
      );
    }
    out = out.replace(from, to);
  }

  // Residual-TODO sweep: a comment line legitimately keeps its `# TODO`, so skip
  // those; any non-comment line still carrying TODO means a value stub slipped
  // through and the resulting stack would not validate.
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
