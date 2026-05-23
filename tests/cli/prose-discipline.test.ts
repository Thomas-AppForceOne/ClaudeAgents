/**
 * Prose-discipline backstop for all CLI output surfaces (feature backstop F4).
 *
 * F4 forbids bare tooling tokens — `npm`, `node`/`Node`, `MCP server` — in any
 * user-facing CLI text. The rule exists because the shipped CLI must read as
 * tool-agnostic prose; an unquoted "npm" or "node" leaks an implementation
 * assumption about how the user runs things. The convention is that any such
 * token, when it must appear, is wrapped in backticks (treated as a code span).
 *
 * This suite is the enforcement net: it sweeps every output surface the CLI can
 * produce — top-level and per-subcommand help, success renderers, every error
 * and stub path, the inner-dispatch errors, and the hooks-status human surface
 * (both in-run and out-of-run) — and asserts zero bare tokens anywhere. When a
 * violation is found the test throws with the offending token plus surrounding
 * context, so a regression names exactly where the leak is.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

// The forbidden-token matcher. The negative look-behind/ahead `(?<!`)…(?!`)`
// deliberately EXEMPTS backtick-wrapped occurrences, so `\`npm\`` (an
// intentional code span) is allowed while a bare `npm` is flagged. Global flag
// so matchAll finds every occurrence, not just the first.
const PROSE_TOKEN = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;

// Every shipped subcommand whose --help (and stub/error) output is swept below.
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

// Collect every bare-token violation in `text`, each annotated with a ±30-char
// window of surrounding context so a failure message pinpoints the leak rather
// than just reporting a count.
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

    const trust = await runGan(['trust', 'info']);
    const violations = findViolations(trust.stdout + trust.stderr);
    expect(violations).toHaveLength(0);
  });

  // Belt-and-braces: beyond the token regex, explicitly forbid the most common
  // tool-specific phrases so they cannot creep back in even backtick-wrapped.
  // The `--help` sentinel in the list is handled as a top-level flag (no
  // subcommand prefix); everything else is run as `<sub> --help`.
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
    // One case per distinct error class — key-not-found (human + json), missing
    // argument, unknown stack, and a non-existent project root — so the sweep
    // covers the variety of error renderers, not just one path.
    const cases: Array<{ argv: string[] }> = [

      { argv: ['config', 'get', 'no.such.path', '--project-root', fixture] },
      { argv: ['config', 'get', 'no.such.path', '--project-root', fixture, '--json'] },

      { argv: ['config', 'get', '--project-root', fixture] },
      { argv: ['stack', 'show', '--project-root', fixture] },

      { argv: ['stack', 'show', 'definitely-not-a-stack', '--project-root', fixture] },

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

  // A second teardown registry, scoped to the write tests below (S3) which need
  // a mutable project copy. Declared here mid-describe (rather than at the top)
  // so it sits next to the write cases that use it.
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

  // Disposable fixture copy for the write-surface (S3) prose checks, so a real
  // `config set` / `stack update` can run and have its output swept.
  function makeTmpProject(): string {
    const fixture = stackFixturePath('js-ts-minimal');
    const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-prose-'));
    cpSync(fixture, dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  it('S3 write success-surface prose obeys discipline', async () => {
    const proj = makeTmpProject();

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

      { argv: ['config', 'set', '--project-root', proj] },
      { argv: ['config', 'set', 'runner.thresholdOverride', '--project-root', proj] },
      { argv: ['stack', 'update', '--project-root', proj] },
      { argv: ['stack', 'update', 'web-node', '--project-root', proj] },

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

  it('F7 hooks-status human surface obeys prose discipline (out-of-run + in-run)', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'gan-prose-hooks-home-'));
    const cwd = mkdtempSync(path.join(tmpdir(), 'gan-prose-hooks-cwd-'));
    tmpDirs.push(home, cwd);

    const outOfRun = await runGan(['hooks', 'status'], { cwd, extraEnv: { HOME: home } });
    expect(outOfRun.exitCode).toBe(0);

    const inRun = await runGan(['hooks', 'status'], {
      cwd,
      extraEnv: {
        HOME: home,
        GAN_RUN_ID: '20240115T091500-a1b2',
        GAN_WORKTREE: path.join(cwd, 'worktree'),
        GAN_RUN_DIR: path.join(cwd, 'rundir'),
      },
    });
    expect(inRun.exitCode).toBe(0);

    for (const r of [outOfRun, inRun]) {
      const violations = findViolations(r.stdout + r.stderr);
      if (violations.length > 0) {
        throw new Error(
          `F4 prose violations in hooks-status surface:\n` +
            violations.map((v) => `  @${v.index} '${v.match}': …${v.context}…`).join('\n'),
        );
      }
    }
  });

  it('S2 inner-dispatch error surfaces obey prose discipline', async () => {

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
