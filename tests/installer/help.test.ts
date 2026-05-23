/**
 * Coverage for `install.sh --help` / `-h` and unknown-flag handling.
 *
 * What this verifies: `--help` prints the help body to stdout, exits 0, and
 * names the documented flags, the Node version floor, and the framework
 * (F-AC1); `-h` is a byte-identical alias (F-AC2); an unknown flag exits 2 with
 * a stderr message that names the bad flag and points at `--help`, writing
 * nothing to stdout (F-AC3); and the help body obeys the F4 prose discipline —
 * runtime tokens like npm/node/MCP-server appear only inside backticks (G1).
 *
 * What it guards (WHY): help text is user-facing contract. The byte-identity
 * of `-h` prevents the two paths drifting apart; the F4 prose check keeps the
 * installer's user-facing copy framework-centric rather than leaking
 * implementation tokens. Each helper home is freshly minted so help runs in
 * isolation.
 */

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

    // Match a runtime token only when it is NOT immediately backtick-wrapped
    // (lookbehind/lookahead on `` ` ``): bare prose mentions are F4 violations,
    // code-span mentions are allowed. Violations are reported with surrounding
    // context to make the offending passage easy to find.
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
