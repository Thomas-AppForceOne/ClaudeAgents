
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildScaffold } from '../../../src/cli/lib/scaffold.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import { validateAll } from '../../../src/config-server/tools/validate.js';
import { runGan } from '../helpers/spawn.js';
import { applyScaffoldFirstEditText } from '../helpers/scaffold-edit.js';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-stacks-new-'));
  tmpDirs.push(dir);
  return dir;
}

describe('gan stacks new — default tier (project)', () => {
  it('writes <root>/.claude/gan/stacks/<name>.md and exits 0', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', 'web-node', '--project-root', proj]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const canonicalRoot = canonicalizePath(proj);
    const target = path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'web-node.md');
    expect(existsSync(target)).toBe(true);
    expect(r.stdout).toContain(target);
  });

  it('the written bytes equal buildScaffold(name) byte-for-byte', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', 'web-node', '--project-root', proj]);
    expect(r.exitCode).toBe(0);
    const canonicalRoot = canonicalizePath(proj);
    const target = path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'web-node.md');
    const written = readFileSync(target, 'utf8');
    expect(written).toBe(buildScaffold('web-node'));
  });
});

describe('gan stacks new — rejected tiers name both supported values (R6)', () => {
  for (const bad of ['repo', 'builtin', 'weird-unknown']) {
    it(`--tier=${bad} exits 64 with a message naming BOTH 'project' and 'user'; no file created`, async () => {
      const proj = makeTmpProject();
      const r = await runGan([
        'stacks',
        'new',
        'web-node',
        `--tier=${bad}`,
        '--project-root',
        proj,
      ]);
      expect(r.exitCode).toBe(64);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/--tier/);
      expect(r.stderr).toMatch(/project/);
      expect(r.stderr).toMatch(/user/);
      expect(r.stderr).toContain(bad);
      const canonicalRoot = canonicalizePath(proj);
      expect(existsSync(path.join(proj, '.claude', 'gan', 'stacks', 'web-node.md'))).toBe(false);
      expect(
        existsSync(path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'web-node.md')),
      ).toBe(false);
    });
  }

  it('--tier with no value (bare boolean) exits 64 naming the flag', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', 'web-node', '--tier', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--tier/);
  });

  it("--tier='' (empty value) exits 64 naming both supported values", async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', 'web-node', '--tier=', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/project/);
    expect(r.stderr).toMatch(/user/);
  });
});

describe('gan stacks new — --tier=user (R6 slice 2)', () => {
  function makeUserHome(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-user-home-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('writes ~/.claude/gan/stacks/<name>.md under the user home, independent of --project-root', async () => {
    const proj = makeTmpProject();
    const home = makeUserHome();
    const r = await runGan(['stacks', 'new', 'my-rust', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    const userTarget = path.join(home, '.claude', 'gan', 'stacks', 'my-rust.md');
    expect(existsSync(userTarget)).toBe(true);
    expect(r.stdout).toContain(userTarget);
    expect(r.stdout).not.toContain(proj);
    expect(existsSync(path.join(proj, '.claude', 'gan', 'stacks', 'my-rust.md'))).toBe(false);
    expect(
      existsSync(path.join(canonicalizePath(proj), '.claude', 'gan', 'stacks', 'my-rust.md')),
    ).toBe(false);
  });

  it('written bytes equal buildScaffold(name, "user") byte-for-byte (atomic write)', async () => {
    const proj = makeTmpProject();
    const home = makeUserHome();
    const r = await runGan(['stacks', 'new', 'my-rust', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    const userTarget = path.join(home, '.claude', 'gan', 'stacks', 'my-rust.md');
    const written = readFileSync(userTarget, 'utf8');
    expect(written).toBe(buildScaffold('my-rust', 'user'));

    const fs = await import('node:fs');
    const dir = path.join(home, '.claude', 'gan', 'stacks');
    expect(fs.readdirSync(dir)).toEqual(['my-rust.md']);
  });

  it('success message names the user tier and the absolute user-tier path', async () => {
    const proj = makeTmpProject();
    const home = makeUserHome();
    const r = await runGan(['stacks', 'new', 'my-rust', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(tier: user)');
    expect(r.stdout).toContain(path.join(home, '.claude', 'gan', 'stacks', 'my-rust.md'));
  });

  it('JSON success surface reports tier=user and the resolved user-tier path', async () => {
    const proj = makeTmpProject();
    const home = makeUserHome();
    const r = await runGan(
      ['stacks', 'new', 'my-rust', '--tier=user', '--project-root', proj, '--json'],
      { extraEnv: { GAN_USER_HOME: home } },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { tier: string; path: string; written: boolean };
    expect(parsed.tier).toBe('user');
    expect(parsed.written).toBe(true);
    expect(parsed.path).toBe(path.join(home, '.claude', 'gan', 'stacks', 'my-rust.md'));
  });

  it('no-overwrite rule holds at the user tier: exits 1, file unchanged, path named', async () => {
    const proj = makeTmpProject();
    const home = makeUserHome();
    const dir = path.join(home, '.claude', 'gan', 'stacks');
    const target = path.join(dir, 'my-rust.md');
    const fs = await import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    const sentinel = 'EXISTING-USER-TIER-DO-NOT-OVERWRITE\n';
    writeFileSync(target, sentinel, 'utf8');

    const r = await runGan(['stacks', 'new', 'my-rust', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(target);
    expect(readFileSync(target, 'utf8')).toBe(sentinel);
  });
});

describe('gan stacks new — --tier=project explicit & default unchanged (regression)', () => {
  it('--tier=project resolves the project path, bytes equal buildScaffold(name, "project")', async () => {
    const proj = makeTmpProject();
    const r = await runGan([
      'stacks',
      'new',
      'web-node',
      '--tier=project',
      '--project-root',
      proj,
    ]);
    expect(r.exitCode).toBe(0);
    const canonicalRoot = canonicalizePath(proj);
    const target = path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'web-node.md');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(buildScaffold('web-node', 'project'));
    expect(r.stdout).toContain('(tier: project)');
  });

  it('no --tier still writes the project path, bytes equal buildScaffold(name) default', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', 'web-node', '--project-root', proj]);
    expect(r.exitCode).toBe(0);
    const canonicalRoot = canonicalizePath(proj);
    const target = path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'web-node.md');
    expect(readFileSync(target, 'utf8')).toBe(buildScaffold('web-node'));
    expect(buildScaffold('web-node')).toBe(buildScaffold('web-node', 'project'));
  });
});

describe('gan stacks new — no-overwrite rule', () => {
  it('exits 1 when the target exists, file is unchanged, stderr names the absolute path', async () => {
    const proj = makeTmpProject();
    const canonicalRoot = canonicalizePath(proj);
    const dir = path.join(canonicalRoot, '.claude', 'gan', 'stacks');

    const target = path.join(dir, 'web-node.md');

    const fs = await import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    const sentinel = 'EXISTING-DO-NOT-OVERWRITE\n';
    writeFileSync(target, sentinel, 'utf8');
    const beforeStat = statSync(target);

    const r = await runGan(['stacks', 'new', 'web-node', '--project-root', proj]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(target);

    const after = readFileSync(target, 'utf8');
    expect(after).toBe(sentinel);

    const afterStat = statSync(target);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
  });
});

describe('gan stacks new — pre-existing --tier help line is now truthful (R6, not rewritten)', () => {
  it('the help.ts flags block still documents --tier=project|user verbatim', async () => {
    const { renderSubcommandHelp } = await import('../../../src/cli/lib/help.js');
    const text = renderSubcommandHelp('stacks');
    expect(text).toContain(
      '--tier=project|user   Where to scaffold/customize/reset (default: project).',
    );
  });

  it('end-to-end: --tier=user succeeds, proving the pre-existing help line is behaviourally true', async () => {
    const proj = makeTmpProject();
    const home = mkdtempSync(path.join(tmpdir(), 'gan-cli-help-home-'));
    tmpDirs.push(home);
    const r = await runGan(['stacks', 'new', 'helper-stack', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(tier: user)');
  });
});

describe('gan stacks new — argument errors', () => {
  it('missing name argument exits 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/stack name/);
  });
});

describe('gan stacks new — R6 headline contract, end-to-end through validateAll', () => {
  function makeIsolatedHome(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-isolated-home-'));
    tmpDirs.push(dir);
    return dir;
  }

  const PROSE_BANNER = (i: { code: string; field?: string }): boolean =>
    i.code === 'InvariantViolation' && (i.field ?? '') === '/prose';
  const DETECTION_TIER3 = (i: { code: string; field?: string }): boolean =>
    i.code === 'InvariantViolation' && (i.field ?? '') === '/detection';

  it('project tier: scaffold → first-edit pass → validateAll reports ZERO issues', async () => {
    const proj = makeTmpProject();
    const home = makeIsolatedHome();
    const r = await runGan(['stacks', 'new', 'acme-svc', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);

    const canonicalRoot = canonicalizePath(proj);
    const target = path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'acme-svc.md');
    const edited = applyScaffoldFirstEditText(readFileSync(target, 'utf8'));
    writeFileSync(target, edited, 'utf8');

    const { issues } = validateAll({ projectRoot: canonicalRoot }, { userHome: home });
    expect(
      issues,
      `expected zero validateAll issues, got: ${JSON.stringify(issues, null, 2)}`,
    ).toEqual([]);

    expect(issues.some(PROSE_BANNER)).toBe(false);
    expect(issues.some(DETECTION_TIER3)).toBe(false);
  });

  it('user tier: scaffold → first-edit pass → validateAll reports ZERO issues', async () => {
    const proj = makeTmpProject();
    const home = makeIsolatedHome();
    const r = await runGan(['stacks', 'new', 'my-rust', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);

    const target = path.join(home, '.claude', 'gan', 'stacks', 'my-rust.md');
    const edited = applyScaffoldFirstEditText(readFileSync(target, 'utf8'));
    writeFileSync(target, edited, 'utf8');

    const { issues } = validateAll({ projectRoot: canonicalizePath(proj) }, { userHome: home });
    expect(
      issues,
      `expected zero validateAll issues, got: ${JSON.stringify(issues, null, 2)}`,
    ).toEqual([]);
    expect(issues.some(DETECTION_TIER3)).toBe(false);
  });

  it('un-edited scaffold STILL fails validateAll on the DRAFT banner (friction preserved end-to-end)', async () => {
    const proj = makeTmpProject();
    const home = makeIsolatedHome();
    const r = await runGan(['stacks', 'new', 'acme-svc', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);

    const { issues } = validateAll(
      { projectRoot: canonicalizePath(proj) },
      { userHome: home },
    );
    expect(issues.some(PROSE_BANNER)).toBe(true);
    expect(issues.some(DETECTION_TIER3)).toBe(false);
  });
});
