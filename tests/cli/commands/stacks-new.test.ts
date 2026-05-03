/**
 * R3 sprint 4 — `gan stacks new` spawn-based tests.
 *
 * Covers the dispatcher wiring and scaffold-contract criteria: default
 * tier writes to `<root>/.claude/gan/stacks/<name>.md`, `--tier=user`
 * rejection, `--tier=repo` rejection (post-R audit Sprint 7 — no
 * end-user-facing repo tier; built-in stacks ship inside the framework
 * package), no-overwrite refusal, atomic write through `atomicWriteFile`,
 * and byte-for-byte equality with `buildScaffold(name)`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildScaffold } from '../../../src/cli/lib/scaffold.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
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

describe('gan stacks new — --tier=repo is rejected', () => {
  it('exits 64 with stderr naming --tier and the supported value; no file is created', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', 'web-node', '--tier=repo', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--tier/);
    expect(r.stderr).toMatch(/project/);
    // No file at any tier (check both raw and canonical roots since the
    // tmp dir lives under /var/folders → /private/var/folders on Darwin).
    const canonicalRoot = canonicalizePath(proj);
    expect(existsSync(path.join(proj, '.claude', 'gan', 'stacks', 'web-node.md'))).toBe(false);
    expect(existsSync(path.join(proj, 'stacks', 'web-node.md'))).toBe(false);
    expect(existsSync(path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'web-node.md'))).toBe(
      false,
    );
    expect(existsSync(path.join(canonicalRoot, 'stacks', 'web-node.md'))).toBe(false);
  });
});

describe('gan stacks new — --tier=user is rejected', () => {
  it('exits 64 with a stderr message naming the unsupported tier; no file created', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stacks', 'new', 'web-node', '--tier=user', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--tier/);
    expect(r.stderr).toMatch(/user/);
    // No file at any tier (check both raw and canonical roots since the
    // tmp dir lives under /var/folders → /private/var/folders on Darwin).
    const canonicalRoot = canonicalizePath(proj);
    expect(existsSync(path.join(proj, '.claude', 'gan', 'stacks', 'web-node.md'))).toBe(false);
    expect(existsSync(path.join(proj, 'stacks', 'web-node.md'))).toBe(false);
    expect(existsSync(path.join(canonicalRoot, '.claude', 'gan', 'stacks', 'web-node.md'))).toBe(
      false,
    );
    expect(existsSync(path.join(canonicalRoot, 'stacks', 'web-node.md'))).toBe(false);
  });
});

describe('gan stacks new — no-overwrite rule', () => {
  it('exits 1 when the target exists, file is unchanged, stderr names the absolute path', async () => {
    const proj = makeTmpProject();
    const canonicalRoot = canonicalizePath(proj);
    const dir = path.join(canonicalRoot, '.claude', 'gan', 'stacks');
    // Pre-seed an existing file with sentinel content.
    const target = path.join(dir, 'web-node.md');
    // mkdir manually since the seed file lives in nested dirs.
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

    // mtime preserved (best effort: fs may round; we accept equality).
    const afterStat = statSync(target);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
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
