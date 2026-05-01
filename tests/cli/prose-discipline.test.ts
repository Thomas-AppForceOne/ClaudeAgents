/**
 * R3 sprint 1 — F4 prose-discipline backstop.
 *
 * Walks the entire help surface (top-level + every subcommand --help)
 * plus the unknown-flag and unknown-subcommand error paths via real
 * spawn invocations, and runs the CC-PROSE regex from the contract:
 *
 *   /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/
 *
 * Any match that is not immediately wrapped in backticks is a violation.
 *
 * This test is the runtime backstop for the user-facing-error-text
 * discipline (PROJECT_CONTEXT.md). It runs the CLI rather than parsing
 * the source so help text generated dynamically (e.g. interpolated
 * subcommand names) is also checked.
 */
import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';

const PROSE_TOKEN = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;

const SUBCOMMANDS = [
  'version',
  'validate',
  'config',
  'stacks',
  'stack',
  'modules',
  'trust',
  'help',
];

function findViolations(text: string): Array<{ index: number; match: string; context: string }> {
  const out: Array<{ index: number; match: string; context: string }> = [];
  for (const m of text.matchAll(PROSE_TOKEN)) {
    const idx = m.index ?? 0;
    const start = Math.max(0, idx - 30);
    const end = idx + m[0].length + 30;
    out.push({ index: idx, match: m[0], context: text.slice(start, end) });
  }
  return out;
}

describe('CLI prose discipline (F4 backstop)', () => {
  it('top-level help has no bare npm/node/Node/MCP server tokens', async () => {
    const r = await runGan(['--help']);
    expect(r.exitCode).toBe(0);
    const violations = findViolations(r.stdout);
    if (violations.length > 0) {
      throw new Error(
        `F4 prose violations in top-level help:\n` +
          violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('every subcommand --help has no bare npm/node/Node/MCP server tokens', async () => {
    for (const sub of SUBCOMMANDS) {
      const r = await runGan([sub, '--help']);
      expect(r.exitCode, `subcommand ${sub} --help should exit 0`).toBe(0);
      const allText = r.stdout + r.stderr;
      const violations = findViolations(allText);
      if (violations.length > 0) {
        throw new Error(
          `F4 prose violations in \`gan ${sub} --help\`:\n` +
            violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
        );
      }
    }
  });

  it('unknown-subcommand error path obeys prose discipline', async () => {
    const r = await runGan(['definitely-not-real']);
    expect(r.exitCode).toBe(64);
    const violations = findViolations(r.stderr);
    expect(violations).toHaveLength(0);
  });

  it('unknown-flag error path obeys prose discipline', async () => {
    const r = await runGan(['--definitely-not-real']);
    expect(r.exitCode).toBe(64);
    const violations = findViolations(r.stderr);
    expect(violations).toHaveLength(0);
  });

  it('stub error paths obey prose discipline', async () => {
    for (const sub of ['validate', 'config', 'stacks', 'stack', 'modules']) {
      const r = await runGan([sub]);
      const violations = findViolations(r.stdout + r.stderr);
      expect(violations, `subcommand ${sub} stub`).toHaveLength(0);
    }
    // Trust stub mentions R5 — an upper-case `R5` is fine; the regex tests
    // for `Node`, not `R`, so the trust stub passes by construction. Verify
    // explicitly anyway to lock the contract.
    const trust = await runGan(['trust', 'info']);
    const violations = findViolations(trust.stdout + trust.stderr);
    expect(violations).toHaveLength(0);
  });

  it('belt-and-braces: no `npm install` or `npm run` in any help body', async () => {
    for (const sub of [...SUBCOMMANDS, '--help']) {
      const args = sub.startsWith('--') ? [sub] : [sub, '--help'];
      const r = await runGan(args);
      expect(r.stdout).not.toMatch(/\bnpm install\b/);
      expect(r.stdout).not.toMatch(/\bnpm run\b/);
      expect(r.stdout).not.toMatch(/the npm package/i);
      expect(r.stdout).not.toMatch(/the Node MCP server/i);
    }
  });
});
