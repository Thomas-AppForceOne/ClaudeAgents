/**
 * R-post sprint 6 — `gan stacks reset` spawn-based tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalizePathForDisplay } from '../../../src/config-server/determinism/index.js';
import { runGan } from '../helpers/spawn.js';

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

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function seedCustomization(rootDir: string, name: string, body: string = `# ${name}\n`): string {
  const dir = path.join(rootDir, '.claude', 'gan', 'stacks');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('gan stacks reset — project tier (default)', () => {
  it('deletes <project>/.claude/gan/stacks/<name>.md and exits 0', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    const target = seedCustomization(canonicalizePathForDisplay(proj), 'web-foo');
    expect(existsSync(target)).toBe(true);
    const r = await runGan(['stacks', 'reset', 'web-foo', '--project-root', proj]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(r.stdout).toContain(target);
    expect(r.stdout).toMatch(/tier: project/);
  });

  it('is idempotent: missing file → warning + exit 0', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    const r = await runGan(['stacks', 'reset', 'absent', '--project-root', proj]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/warning:/);
    expect(r.stderr).toContain('absent');
    expect(r.stdout).toBe('');
  });
});

describe('gan stacks reset — user tier', () => {
  it('deletes <userHome>/.claude/gan/stacks/<name>.md', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    const home = makeTmpDir('gan-test-reset-home-');
    const target = seedCustomization(home, 'web-foo');
    const r = await runGan(['stacks', 'reset', 'web-foo', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(r.stdout).toMatch(/tier: user/);
  });

  it('is idempotent on the user tier too', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    const home = makeTmpDir('gan-test-reset-home-');
    const r = await runGan(['stacks', 'reset', 'absent', '--tier=user', '--project-root', proj], {
      extraEnv: { GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/warning:/);
  });
});

describe('gan stacks reset — argument errors', () => {
  it('missing name argument exits 64', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    const r = await runGan(['stacks', 'reset', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/stack name/);
  });

  it('invalid --tier exits 64', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    const r = await runGan(['stacks', 'reset', 'web-foo', '--tier=repo', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/--tier/);
  });
});

describe('gan stacks reset --json', () => {
  it('emits {deleted: true, name, path, tier} on success', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    seedCustomization(canonicalizePathForDisplay(proj), 'web-foo');
    const r = await runGan(['stacks', 'reset', 'web-foo', '--json', '--project-root', proj]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      deleted: boolean;
      name: string;
      path: string;
      tier: string;
    };
    expect(parsed.deleted).toBe(true);
    expect(parsed.name).toBe('web-foo');
    expect(parsed.tier).toBe('project');
    expect(JSON.stringify(Object.keys(parsed))).toBe(
      JSON.stringify(['deleted', 'name', 'path', 'tier']),
    );
  });

  it('emits {deleted: false, reason: "no-customization"} on no-op', async () => {
    const proj = makeTmpDir('gan-test-reset-proj-');
    const r = await runGan(['stacks', 'reset', 'absent', '--json', '--project-root', proj]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      deleted: boolean;
      reason: string;
      tier: string;
    };
    expect(parsed.deleted).toBe(false);
    expect(parsed.reason).toBe('no-customization');
    expect(parsed.tier).toBe('project');
    expect(r.stderr).toMatch(/warning:/);
  });
});
