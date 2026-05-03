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
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

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

  // S2 extension: renderer-owned success surfaces (no fixture data
  // mixed in) obey the F4 prose discipline. We deliberately skip
  // `stack show` here because the stack file's data block contains
  // legitimate ecosystem-specific tokens (`npm run build`, etc.) that
  // are user-provided content, not renderer prose. The other read
  // subcommands print only renderer-owned text on the human path.
  it('S2 success renderer prose obeys discipline (config print, stacks list, modules list)', async () => {
    const fixture = stackFixturePath('js-ts-minimal');
    const cases: string[][] = [
      ['config', 'print', '--project-root', fixture],
      ['stacks', 'list', '--project-root', fixture],
      ['modules', 'list', '--project-root', fixture],
    ];
    for (const argv of cases) {
      const r = await runGan(argv);
      const violations = findViolations(r.stdout + r.stderr);
      if (violations.length > 0) {
        throw new Error(
          `F4 prose violations in success surface for argv=${JSON.stringify(argv)}:\n` +
            violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
        );
      }
    }
  });

  it('S2 error surfaces obey prose discipline', async () => {
    const fixture = stackFixturePath('js-ts-minimal');
    const cases: Array<{ argv: string[] }> = [
      // Missing key.
      { argv: ['config', 'get', 'no.such.path', '--project-root', fixture] },
      { argv: ['config', 'get', 'no.such.path', '--project-root', fixture, '--json'] },
      // Missing arg.
      { argv: ['config', 'get', '--project-root', fixture] },
      { argv: ['stack', 'show', '--project-root', fixture] },
      // Unknown stack — surfaces F2 MissingFile.
      { argv: ['stack', 'show', 'definitely-not-a-stack', '--project-root', fixture] },
      // Bad project root.
      { argv: ['config', 'print', '--project-root', '/definitely/not/a/dir'] },
    ];
    for (const c of cases) {
      const r = await runGan(c.argv);
      const violations = findViolations(r.stdout + r.stderr);
      if (violations.length > 0) {
        throw new Error(
          `F4 prose violations in error surface for argv=${JSON.stringify(c.argv)}:\n` +
            violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
        );
      }
    }
  });

  // S3 extension — write subcommands' renderer prose obeys discipline.
  // We use a tmp project (write commands must not mutate the in-tree
  // fixture). The success surface ("Updated <path> to <value> in <tier>
  // overlay.") quotes user input in backticks so even if a user wrote a
  // literal `npm` the backtick-wrap defuses the regex; the renderer
  // prose itself contains no banned tokens.
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  function makeTmpProject(): string {
    const fixture = stackFixturePath('js-ts-minimal');
    const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-prose-'));
    cpSync(fixture, dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  it('S3 write success-surface prose obeys discipline', async () => {
    const proj = makeTmpProject();
    // config set success.
    const setR = await runGan([
      'config',
      'set',
      'runner.thresholdOverride',
      '8',
      '--project-root',
      proj,
    ]);
    {
      const violations = findViolations(setR.stdout + setR.stderr);
      if (violations.length > 0) {
        throw new Error(
          `F4 prose violations in config-set success surface:\n` +
            violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
        );
      }
    }
    // stack update success — use a value the backtick wrap will neutralise
    // any banned tokens in (`vitest run` is fine on its own).
    const updR = await runGan([
      'stack',
      'update',
      'web-node',
      'lintCmd',
      'vitest run',
      '--project-root',
      proj,
    ]);
    {
      const violations = findViolations(updR.stdout + updR.stderr);
      if (violations.length > 0) {
        throw new Error(
          `F4 prose violations in stack-update success surface:\n` +
            violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
        );
      }
    }
  });

  it('S3 write error surfaces obey prose discipline', async () => {
    const proj = makeTmpProject();
    const cases: Array<{ argv: string[] }> = [
      // Missing args.
      { argv: ['config', 'set', '--project-root', proj] },
      { argv: ['config', 'set', 'runner.thresholdOverride', '--project-root', proj] },
      { argv: ['stack', 'update', '--project-root', proj] },
      { argv: ['stack', 'update', 'web-node', '--project-root', proj] },
      // Invalid --tier values.
      {
        argv: [
          'config',
          'set',
          'runner.thresholdOverride',
          '8',
          '--tier=repo',
          '--project-root',
          proj,
        ],
      },
      {
        argv: [
          'config',
          'set',
          'runner.thresholdOverride',
          '8',
          '--tier=default',
          '--project-root',
          proj,
        ],
      },
      // Schema-violating writes for overlay → renderer prose only (no
      // stack-file path leaks). The stack-update path embeds the stack
      // file's absolute path in error output (e.g. `…/stacks/web-node.md`)
      // which contains user-provided ecosystem tokens; we skip those for
      // the same reason `stack show` is skipped above (user content, not
      // renderer prose).
      {
        argv: ['config', 'set', 'unknownTopLevelKey', '"bogus"', '--project-root', proj],
      },
    ];
    for (const c of cases) {
      const r = await runGan(c.argv);
      const violations = findViolations(r.stdout + r.stderr);
      if (violations.length > 0) {
        throw new Error(
          `F4 prose violations in S3 error surface for argv=${JSON.stringify(c.argv)}:\n` +
            violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
        );
      }
    }
  });

  it('S2 inner-dispatch error surfaces obey prose discipline', async () => {
    // Unknown inner subcommand under each parent (e.g. `gan config nope`).
    const cases = [
      ['config'],
      ['config', 'nope'],
      ['stacks'],
      ['stacks', 'nope'],
      ['stack'],
      ['stack', 'nope'],
      ['modules'],
      ['modules', 'nope'],
    ];
    for (const argv of cases) {
      const r = await runGan(argv);
      const violations = findViolations(r.stdout + r.stderr);
      expect(violations, `argv=${JSON.stringify(argv)}`).toHaveLength(0);
    }
  });
});
