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

const SECOND_LINE =
  '# `gan validate` and CI\'s lint-stacks will fail while this banner is present.';

const AUDIT_STUB =
  '"false  # TODO: replace before committing — your audit command, or remove this field"';

/**
 * Build the scaffold text for a stack named `name`.
 *
 * The function is pure: same input, same output, byte-identical across
 * runs. Callers (`gan stacks new`) write the result via `atomicWriteFile`.
 *
 * Layout:
 *
 *   <BANNER>
 *   <SECOND_LINE>
 *
 *   ---
 *   schemaVersion: 1
 *   name: <name>
 *   ... TODO-stubbed fields ...
 *   ---
 *
 *   ## Conventions
 *
 *   ... TODO-stubbed prose ...
 */
export function buildScaffold(name: string): string {
  const lines: string[] = [];
  lines.push(BANNER);
  lines.push(SECOND_LINE);
  lines.push('');
  lines.push('---');
  lines.push('schemaVersion: 1');
  lines.push(`name: ${name}`);
  lines.push('# TODO: replace the detection rules so this stack only activates when');
  lines.push('# the framework finds the right files in the host repo.');
  lines.push('detection:');
  lines.push('  - anyOf:');
  lines.push('      - "TODO-replace-with-a-real-marker-file"');
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
