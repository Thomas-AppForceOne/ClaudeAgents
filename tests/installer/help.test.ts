
import { afterEach, describe, expect, it } from 'vitest';
import { runInstall } from './helpers/spawn.js';
import { makeTmpHome, type TmpHome } from './helpers/tmpenv.js';

const cleanups: TmpHome[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c.cleanup();
  }
});

function freshHome(): TmpHome {
  const h = makeTmpHome();
  cleanups.push(h);
  return h;
}

describe('install.sh --help / -h', () => {
  it('F-AC1: --help prints the help body to stdout and exits 0', async () => {
    const { home, bin } = freshHome();
    const result = await runInstall(['--help'], { home, prependPath: [bin] });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain('--uninstall');
    expect(result.stdout).toContain('--no-claude-code');

    expect(result.stdout).toContain('20.10');

    expect(result.stdout.toLowerCase()).toContain('exit');
    expect(result.stdout).toMatch(/README/i);

    expect(result.stdout).toContain('Claude Code');

    const claimsFramework =
      result.stdout.includes('ClaudeAgents') || result.stdout.includes('the framework');
    expect(claimsFramework).toBe(true);
  });

  it('F-AC2: -h emits byte-identical output to --help', async () => {
    const { home, bin } = freshHome();
    const long = await runInstall(['--help'], { home, prependPath: [bin] });
    const short = await runInstall(['-h'], { home, prependPath: [bin] });
    expect(short.exitCode).toBe(0);
    expect(short.stderr).toBe('');
    expect(short.stdout).toBe(long.stdout);
  });

  it('F-AC3: unknown flag exits non-zero with a stderr error naming the flag and pointing at --help', async () => {
    const { home, bin } = freshHome();
    const result = await runInstall(['--definitely-not-a-real-flag'], {
      home,
      prependPath: [bin],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--definitely-not-a-real-flag');
    expect(result.stderr).toContain('--help');

    expect(result.stdout).toBe('');
  });

  it('G1: --help body satisfies the F4 prose discipline', async () => {
    const { home, bin } = freshHome();
    const result = await runInstall(['--help'], { home, prependPath: [bin] });
    expect(result.exitCode).toBe(0);

    const proseToken = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;
    const violations = [...result.stdout.matchAll(proseToken)];
    if (violations.length > 0) {
      const formatted = violations.map((m) => {
        const start = Math.max(0, (m.index ?? 0) - 25);
        const end = (m.index ?? 0) + m[0].length + 25;
        return `…${result.stdout.slice(start, end)}…`;
      });
      throw new Error(`F4 prose violations in help body:\n${formatted.join('\n')}`);
    }
    expect(violations).toHaveLength(0);

    expect(result.stdout).not.toMatch(/\bnpm install\b/);
    expect(result.stdout).not.toMatch(/\bnpm run\b/);
    expect(result.stdout).not.toMatch(/the npm package/i);
    expect(result.stdout).not.toMatch(/the Node MCP server/i);
  });
});
