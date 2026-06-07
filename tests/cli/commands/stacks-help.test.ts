/**
 * Verify-only completeness pin for `gan stacks --help`.
 *
 * These assertions guard the shipped help output against silent drift: the
 * surface advertises six subcommands, an "Active vs. available:" explainer
 * paragraph that must sit *before* the `Flags:` header, the literal `Flags:`
 * header (a rename to `Options:` is forbidden by the [D1](D1-diagnostic-clarity.md)
 * spec and must fail here if attempted), and the appended `Global flags:`,
 * `Examples:`, and `Exit codes:` blocks.
 *
 * The assertions are deliberately substring/index-based — never a whole-block
 * equality check — because reproducing the verbatim help block in this test
 * would itself be the drift hazard the verification exists to prevent
 * (two sources of truth for the rendered text). A token-by-token pin catches
 * the regressions the spec names (a missing subcommand, a moved paragraph,
 * a renamed header) without forcing the test to mirror every cosmetic line of
 * the shipped output.
 */

import { describe, expect, it } from 'vitest';
import { runGan } from '../helpers/spawn.js';

describe('gan stacks --help completeness', () => {
  it('exits 0 and advertises every shipped subcommand', async () => {
    const r = await runGan(['stacks', '--help']);

    // The help surface is purely informational; a non-zero exit would signal a
    // misclassified usage error and is therefore part of the contract.
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    // Pin each of the six shipped subcommand names individually so a future
    // accidental drop of a single subcommand row fails this test on the
    // specific missing token, not as a vague whole-block mismatch.
    for (const sub of ['list', 'available', 'new', 'where', 'customize', 'reset']) {
      expect(r.stdout, `subcommand ${sub} should appear in the help text`).toContain(
        `gan stacks ${sub}`,
      );
    }
  });

  it('places the "Active vs. available:" paragraph before the Flags: block', async () => {
    const r = await runGan(['stacks', '--help']);
    expect(r.exitCode).toBe(0);

    const paragraphIdx = r.stdout.indexOf('Active vs. available:');
    const flagsIdx = r.stdout.indexOf('Flags:');

    // Both anchors must be present at all (defensive: a -1 index would silently
    // satisfy the `<` comparison below otherwise).
    expect(paragraphIdx, '"Active vs. available:" paragraph must be present').toBeGreaterThanOrEqual(
      0,
    );
    expect(flagsIdx, '"Flags:" header must be present').toBeGreaterThanOrEqual(0);

    // The position constraint is the contract: the explainer paragraph lives
    // inside the description block (rendered before flags), so a refactor that
    // reorders the help to flags-first must fail here.
    expect(paragraphIdx).toBeLessThan(flagsIdx);
  });

  it('uses the literal `Flags:` header (not `Options:`) and lists --tier and --force', async () => {
    const r = await runGan(['stacks', '--help']);
    expect(r.exitCode).toBe(0);

    // The literal spelling is pinned because the spec explicitly forbids the
    // `Flags:` → `Options:` rename; this assertion catches that exact refactor.
    expect(r.stdout).toContain('Flags:');
    expect(r.stdout).not.toContain('Options:');

    // The two subcommand-local flags advertised under `Flags:` are pinned by
    // token so renaming or removing either breaks this test fast.
    expect(r.stdout).toContain('--tier');
    expect(r.stdout).toContain('--force');

    // Belt-and-braces: the tier/force flags must appear inside the Flags:
    // section (i.e. after the header), not stranded somewhere earlier. An
    // earlier appearance would mean the header was moved or duplicated.
    const flagsIdx = r.stdout.indexOf('Flags:');
    expect(r.stdout.indexOf('--tier')).toBeGreaterThan(flagsIdx);
    expect(r.stdout.indexOf('--force')).toBeGreaterThan(flagsIdx);
  });

  it('renders the appended Global flags, Examples, and Exit codes blocks', async () => {
    const r = await runGan(['stacks', '--help']);
    expect(r.exitCode).toBe(0);

    // These three block headers are part of the appended completeness contract;
    // their exact capitalisation and trailing colon are the shipped spelling,
    // so a casual rename (e.g. `Global Flags`) would fail and surface as a
    // help-surface regression rather than slip out in a release.
    expect(r.stdout).toContain('Global flags:');
    expect(r.stdout).toContain('Examples:');
    expect(r.stdout).toContain('Exit codes:');
  });
});
