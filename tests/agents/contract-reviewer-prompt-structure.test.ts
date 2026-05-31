/**
 * gan-contract-reviewer prompt-structure suite — reads the SHIPPED
 * agents/gan-contract-reviewer.md verbatim and asserts the rewrite preserves
 * the conventional agent-prompt frontmatter shape, the three named
 * house-rules regions are byte-identical to the canonical partial at
 * scripts/house-rules/house-rules.md, and the shipped lint CLIs accept
 * the rewritten prompt (lint-no-spec-ref + house-rules both exit 0).
 *
 * Why this test exists: the contract reviewer is a load-bearing agent in
 * the GAN loop. Its prompt is the only place the role learns its inputs,
 * audits, and verdict shape — a drift in any of frontmatter / house-rules
 * region / lint discipline is invisible at orchestration time but breaks
 * the gate at run time. The shipped CLIs are the authoritative source of
 * truth for the latter two rules; spawning them rather than re-implementing
 * the rule set keeps this test honest as the CLIs evolve.
 *
 * The minimal `---`-delimited frontmatter parser mirrors the shape the
 * shipped house-rules CLI uses, so the test does not depend on a YAML
 * library the rest of the repo does not consume. The slice-between-
 * sentinels helper compares each named region byte-for-byte (sentinels
 * included), so whitespace drift inside or around a region is caught.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-reviewer.md');
const partialPath = path.join(repoRoot, 'scripts', 'house-rules', 'house-rules.md');
const prompt = readFileSync(promptPath, 'utf8');
const partial = readFileSync(partialPath, 'utf8');

// Minimal `---`-delimited YAML frontmatter parser — sufficient because this
// test only inspects presence and exact values of a known small key set.
// Avoids pulling in a YAML dependency the rest of the repo does not use.
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
 * from the `:start` sentinel through the `:end` sentinel inclusive. The
 * byte-equality check that consumes this output therefore catches any
 * whitespace drift inside or around the region.
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

describe('gan-contract-reviewer — frontmatter shape', () => {
  it('the frontmatter parses', () => {
    const fm = parseFrontmatter(prompt);
    expect(fm).not.toBeNull();
  });

  it('name equals gan-contract-reviewer', () => {
    const fm = parseFrontmatter(prompt)!;
    expect(fm['name']).toBe('gan-contract-reviewer');
  });

  it('description is present and non-empty', () => {
    const fm = parseFrontmatter(prompt)!;
    expect(fm['description']).toBeDefined();
    expect(fm['description']!.length).toBeGreaterThan(0);
  });

  it('tools is the rewrite-mandated set (Bash present so the reviewer can shell git diff)', () => {
    // The well-foundedness audit requires the reviewer to obtain the
    // committed sprint diff via `git diff`; the Bash tool must therefore be
    // declared in the frontmatter. Read / Write / Glob round out the
    // file-inspection capabilities the reviewer needs.
    const fm = parseFrontmatter(prompt)!;
    expect(fm['tools']).toBe('Bash, Read, Write, Glob');
  });

  it('model is opus (parity with the other GAN-loop agents)', () => {
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

describe('gan-contract-reviewer — house-rules region parity', () => {
  for (const name of ['hr:snapshot', 'hr:no-config-api', 'hr:errors-tail']) {
    it(`${name} region is present and byte-identical to the canonical partial`, () => {
      const promptRegion = extractRegionWithSentinels(prompt, name);
      const partialRegion = extractRegionWithSentinels(partial, name);
      expect(promptRegion).toBe(partialRegion);
    });
  }
});

describe('gan-contract-reviewer — lints pass against the shipped CLIs', () => {
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
    // check covers the rewritten agent. A failure here means a region
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
