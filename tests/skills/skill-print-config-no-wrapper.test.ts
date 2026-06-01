// Content guard for the `--print-config` description prose in
// skills/gan/SKILL.md.
//
// The shipped product surface (`/gan --print-config` flag and the
// orchestrator's inspection short-circuit) must describe the resolved
// configuration as the *flat* `getResolvedConfig()` shape — `issues` and
// `warnings` live inside the resolved object, not as separate top-level
// `resolvedConfig` + `validationErrors` keys. A regression that reintroduces
// the wrapper assertion would diverge SKILL.md from the shipped `gan config
// print --json` output and break the byte-identical AC.
//
// We slice the two prose blocks the spec calls out (the "Argument parsing"
// table row and the "Inspection and recovery short-circuits" bullet) and pin
// two invariants on each: (a) the prose does not assert that
// `resolvedConfig` + `validationErrors` are emitted as top-level keys; (b)
// the prose names the flat resolved-config object with `issues` (and, where
// applicable, `warnings`) inside it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root derives from this test file's location to mirror the resolution
// scheme the sibling skill-content tests use; this avoids a process.cwd()
// dependency that would silently break under a different test-runner
// invocation.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

// The `--print-config` row inside the "Argument parsing" flag table; the row
// starts at `| \`--print-config\` |` and ends at the next pipe-delimited row
// or a non-table line.
function slicePrintConfigTableRow(content: string): string {
  const rowStart = content.indexOf('| `--print-config`');
  if (rowStart === -1) {
    throw new Error('--print-config row not found in SKILL.md');
  }
  const rowEnd = content.indexOf('\n', rowStart);
  return content.slice(rowStart, rowEnd === -1 ? content.length : rowEnd);
}

// The `--print-config` bullet inside the "Inspection and recovery
// short-circuits" section; the bullet starts at `- \`--print-config\`` and
// ends at the next blank line or top-level header.
function slicePrintConfigBullet(content: string): string {
  const bulletStart = content.indexOf('- `--print-config`');
  if (bulletStart === -1) {
    throw new Error('--print-config bullet not found in SKILL.md');
  }
  // The bullet ends at the next blank line followed by a non-list character;
  // we approximate that by searching for the next newline that starts a
  // non-indented line and is preceded by a blank line. A simpler bound — the
  // next `\n- ` (the next sibling bullet) — is sufficient because the
  // bulleted list is the structural anchor.
  const nextBullet = content.indexOf('\n- ', bulletStart + 1);
  const nextHeading = content.indexOf('\n#', bulletStart + 1);
  const candidates = [nextBullet, nextHeading].filter((i) => i >= 0);
  const end = candidates.length === 0 ? content.length : Math.min(...candidates);
  return content.slice(bulletStart, end);
}

describe('skills/gan/SKILL.md — --print-config describes the flat shape, not a wrapper', () => {
  const content = readFileSync(skillPath, 'utf8');
  const tableRow = slicePrintConfigTableRow(content);
  const bullet = slicePrintConfigBullet(content);

  it('--print-config table row does not assert a `resolvedConfig` + `validationErrors` top-level wrapper', () => {
    // A wrapper assertion would look like "emits `resolvedConfig` and
    // `validationErrors` as top-level keys"; we reject any prose where both
    // tokens appear with positive framing. Allowing the negation (the prose
    // explicitly saying "no `resolvedConfig`/`validationErrors` wrapper") is
    // useful documentation, so we only flag the positive co-occurrence.
    const positiveWrapperAssertion =
      /resolvedConfig\b.*\bvalidationErrors\b.*\b(top[- ]level|emit(s|ted))/i;
    expect(tableRow).not.toMatch(positiveWrapperAssertion);
  });

  it('--print-config table row names the flat resolved-config object and points at the inner `issues` array', () => {
    // The flat shape is the load-bearing assertion: the table row must
    // describe the output as the resolved-config object with `issues` inside
    // it (and not as two parallel top-level keys).
    expect(tableRow).toMatch(/resolved[- ]config\b/i);
    expect(tableRow).toContain('issues');
  });

  it('--print-config bullet does not assert a `resolvedConfig` + `validationErrors` top-level wrapper', () => {
    const positiveWrapperAssertion =
      /resolvedConfig\b.*\bvalidationErrors\b.*\b(top[- ]level|emit(s|ted))/i;
    expect(bullet).not.toMatch(positiveWrapperAssertion);
  });

  it('--print-config bullet names the flat resolved-config object with `issues` and `warnings` inside it', () => {
    // The "Failure mode: fail-open" prose in the spec calls out both inner
    // arrays; the bullet is the prose surface that pins them.
    expect(bullet).toMatch(/resolved[- ]config\b/i);
    expect(bullet).toContain('issues');
    expect(bullet).toContain('warnings');
  });
});
