/**
 * gan-reviewer-independent prompt-structure suite — reads the SHIPPED
 * agents/gan-reviewer-independent.md verbatim and asserts the contract
 * sprint 1 pins:
 *
 * - frontmatter parses and carries exactly name=gan-reviewer-independent,
 *   description (non-empty), tools="Bash, Read, Write, Glob, Grep",
 *   model=opus, with no additional frontmatter keys outside the
 *   conventional agent-prompt set.
 * - the three named house-rules regions (hr:snapshot, hr:no-config-api,
 *   hr:errors-tail) are present and byte-identical to the corresponding
 *   regions in scripts/house-rules/house-rules.md (the canonical partial
 *   the parity script reads).
 * - the prompt body instructs the reviewer to obtain the diff via `git
 *   diff` (the substring "diff" appears in the body) and does NOT
 *   instruct the reviewer to read the sprint contract file or declare a
 *   contract-path input variable in its inputs section.
 * - the prompt body forbids pass/fail verdicts — the reviewer is a
 *   criterion source only.
 * - the prompt passes the shipped lint-no-spec-ref CLI (exit 0).
 * - the prompt passes the shipped house-rules CLI (exit 0).
 *
 * The frontmatter parser is intentionally minimal — the same shape the
 * shipped house-rules CLI uses — so the test does not add a dependency
 * on a YAML library the rest of the repo does not consume.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-reviewer-independent.md');
const partialPath = path.join(repoRoot, 'scripts', 'house-rules', 'house-rules.md');
const prompt = readFileSync(promptPath, 'utf8');
const partial = readFileSync(partialPath, 'utf8');

// Minimal `---`-delimited YAML frontmatter parser — the same shape used by
// the shipped house-rules CLI. Returns the keyed fields or null when the
// file lacks a frontmatter block. Sufficient because this test only
// inspects presence and exact values of a known small key set.
function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0] !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i += 1) {
    const line = lines[i]!;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Extract a named house-rules region from `text`, returning the substring
 * from the `:start` sentinel to the `:end` sentinel inclusive. The
 * comparison this test runs is byte-equality between the same-named
 * region in the prompt and in the canonical partial, including the
 * sentinel lines themselves — so any whitespace drift inside or around
 * the region is caught.
 */
function extractRegionWithSentinels(text: string, name: string): string {
  const startMarker = `<!-- ${name}:start -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  expect(startIdx, `start sentinel for ${name} present`).toBeGreaterThan(-1);
  expect(endIdx, `end sentinel for ${name} present`).toBeGreaterThan(startIdx);
  return text.slice(startIdx, endIdx + endMarker.length);
}

// Slice the prompt body (everything after the closing `---` of the
// frontmatter) so checks on body-content do not accidentally inspect the
// frontmatter's `description`, which is allowed to mention the contract
// for cataloguing purposes.
function promptBody(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return text;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return text;
  return lines.slice(closeIdx + 1).join('\n');
}

describe('gan-reviewer-independent — frontmatter shape', () => {
  it('the frontmatter parses', () => {
    const fm = parseFrontmatter(prompt);
    expect(fm).not.toBeNull();
  });

  it('name equals gan-reviewer-independent', () => {
    const fm = parseFrontmatter(prompt)!;
    expect(fm['name']).toBe('gan-reviewer-independent');
  });

  it('description is present and non-empty', () => {
    const fm = parseFrontmatter(prompt)!;
    expect(fm['description']).toBeDefined();
    expect(fm['description']!.length).toBeGreaterThan(0);
  });

  it('tools is exactly the contract-mandated set, in order', () => {
    const fm = parseFrontmatter(prompt)!;
    expect(fm['tools']).toBe('Bash, Read, Write, Glob, Grep');
  });

  it('model is opus (parity with the generator, per the spec)', () => {
    const fm = parseFrontmatter(prompt)!;
    expect(fm['model']).toBe('opus');
  });

  it('declares only the conventional agent-prompt frontmatter keys (name, description, tools, model)', () => {
    const fm = parseFrontmatter(prompt)!;
    const expected = new Set(['name', 'description', 'tools', 'model']);
    for (const key of Object.keys(fm)) {
      expect(expected, `unexpected frontmatter key: ${key}`).toContain(key);
    }
  });
});

describe('gan-reviewer-independent — house-rules region parity', () => {
  for (const name of ['hr:snapshot', 'hr:no-config-api', 'hr:errors-tail']) {
    it(`${name} region is present and byte-identical to the canonical partial`, () => {
      const promptRegion = extractRegionWithSentinels(prompt, name);
      const partialRegion = extractRegionWithSentinels(partial, name);
      expect(promptRegion).toBe(partialRegion);
    });
  }
});

describe('gan-reviewer-independent — reviews the diff, not the contract', () => {
  it('the body instructs the reviewer to obtain the diff (the substring "diff" appears in the body)', () => {
    const body = promptBody(prompt);
    // Case-insensitive substring check: the body mentions `git diff` at
    // minimum; the precise wording is not pinned, only that the diff is
    // the review subject.
    expect(body.toLowerCase()).toContain('diff');
  });

  it('the Inputs section does NOT declare a contract-path input variable', () => {
    // Locate the Inputs section (heading to next `## ` heading) and assert
    // it carries no sprint-contract path input. The reviewer's
    // independence depends structurally on never being handed the
    // pre-written criteria, so a path bullet here would be a contract
    // violation.
    const inputsHeadIdx = prompt.indexOf('## Inputs');
    expect(inputsHeadIdx, '## Inputs heading must exist').toBeGreaterThan(-1);
    const afterHead = prompt.slice(inputsHeadIdx);
    const nextHeadingIdx = afterHead.indexOf('\n## ', '## Inputs'.length);
    const inputsSection =
      nextHeadingIdx === -1 ? afterHead : afterHead.slice(0, nextHeadingIdx);
    // The forbidden substrings: a path or input bullet for the proposer's
    // locked criteria file. Use the literal patterns the orchestrator
    // would write if this slipped through.
    const lower = inputsSection.toLowerCase();
    expect(lower).not.toContain('sprint-{n}-contract.json');
    expect(lower).not.toContain('sprint contract');
    expect(lower).not.toContain('the sprint-contract');
    expect(lower).not.toMatch(/\bcontract path\b/);
    expect(lower).not.toMatch(/\bcontract file\b/);
  });

  it('the body forbids the reviewer from marking pass/fail', () => {
    const body = promptBody(prompt);
    // Pin two affirmative anti-gating statements — the prompt body must
    // assert at least one of these in some form. The check looks for the
    // phrases the spec wording uses; a paraphrase that preserves the
    // meaning is allowed.
    const lower = body.toLowerCase();
    const hasNoPassFail =
      /you never mark a sprint pass or fail/.test(lower) ||
      /do not mark the sprint as passing or failing/.test(lower);
    expect(hasNoPassFail, 'body must explicitly forbid the reviewer from marking pass/fail').toBe(
      true,
    );
    const hasCriterionSource =
      /criterion source/.test(lower) || /not a gate/.test(lower);
    expect(
      hasCriterionSource,
      'body must frame the role as a criterion source (or explicitly "not a gate")',
    ).toBe(true);
  });
});

describe('gan-reviewer-independent — lints pass against the shipped CLIs', () => {
  it('passes lint-no-spec-ref over the agents/ scan scope', () => {
    // Spawn the compiled CLI rather than re-implementing its rules; the
    // CLI is the authoritative source of truth for the "no internal
    // spec-references in agents/" rule. The compiled artefact lives in
    // dist/scripts/; an absent dist (caller forgot to build) surfaces as
    // a spawn error rather than a silent skip.
    const cli = path.join(repoRoot, 'dist', 'scripts', 'lint-no-spec-ref', 'index.js');
    let exit = 0;
    try {
      execFileSync(process.execPath, [cli, '--scan-root', repoRoot, '--quiet'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch (e) {
      exit = (e as { status?: number }).status ?? 1;
    }
    expect(exit).toBe(0);
  });

  it('passes the house-rules parity CLI', () => {
    // Same arrangement as above: the CLI's per-region byte-equality
    // check covers the new agent. A failure here means a region
    // drifted from the canonical partial or a frontmatter field is
    // missing.
    const cli = path.join(repoRoot, 'dist', 'scripts', 'house-rules', 'index.js');
    let exit = 0;
    try {
      execFileSync(process.execPath, [cli, '--scan-root', repoRoot, '--quiet'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch (e) {
      exit = (e as { status?: number }).status ?? 1;
    }
    expect(exit).toBe(0);
  });
});
