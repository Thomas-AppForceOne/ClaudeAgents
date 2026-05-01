/**
 * Single-source DRAFT banner for `gan stacks new` scaffolds.
 *
 * Per the scaffold-banner verbatim rule (PROJECT_CONTEXT.md, R3-locked):
 * the DRAFT banner emitted by `gan stacks new` is a single canonical
 * constant. R1's `stack-no-draft-banner` invariant and R3's CLI scaffold
 * helper both import this constant; nobody hand-types the banner string.
 *
 * Format: a single line starting with `# ` followed by the literal
 * sentence shown below (em-dash U+2014, trailing period). No trailing
 * newline — callers join lines themselves.
 *
 * Any text change here is a coordinated edit across R1 + R3 + R4 plus the
 * `tests/fixtures/stacks/invariant-stack-draft-banner/` fixture. The
 * single-occurrence rule for the literal in `src/` is enforced by the
 * sprint contract's anti-criteria.
 */

export const DRAFT_BANNER = '# DRAFT — replace TODOs before committing.';
