import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { detectActiveStacks } from '../../../src/config-server/resolution/detection.js';
import { _runPhase1ForTests } from '../../../src/config-server/tools/validate.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

const STUB_OVERLAY = ['---', 'schemaVersion: 1', '---', '', ''].join('\n');

function makeStackFile(name: string, body: string): string {
  return ['---', `name: ${name}`, 'schemaVersion: 1', body.trim(), '---', '', ''].join('\n');
}

function hydrateSnapshot(projectRoot: string) {
  const snapshot = _runPhase1ForTests(projectRoot);
  for (const row of snapshot.stackFiles.values()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const text = readFileSync(row.path, 'utf8');
      const parsed = parseYamlBlock(text, row.path);
      row.data = parsed.data;
      row.prose = parsed.prose;
    } catch {
      // ignore
    }
  }
  return snapshot;
}

describe('detectActiveStacks — C2 dispatch', () => {
  let workRoot: string;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'cas-detection-'));
    // .claude/gan/project.md (overlay) so phase 1 considers the project.
    mkdirSync(path.join(workRoot, '.claude', 'gan'), { recursive: true });
    writeFileSync(path.join(workRoot, '.claude', 'gan', 'project.md'), STUB_OVERLAY);
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('non-empty stack.override → exactly that list, no auto-detection', () => {
    // Two built-in stacks; only one matches detection. Override forces both.
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'web-node.md'),
      makeStackFile('web-node', 'detection:\n  - package.json'),
    );
    writeFileSync(
      path.join(stacksDir, 'docker.md'),
      makeStackFile('docker', 'detection:\n  - Dockerfile'),
    );
    // No package.json or Dockerfile on disk: auto-detection would match nothing.
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, { stackOverride: ['web-node', 'docker'] });
    expect(result.active).toEqual(['docker', 'web-node']);
    expect(result.issues).toEqual([]);
  });

  it('empty stack.override after cascade → run auto-detection', () => {
    // Seed a `package.json` so web-node's detection matches.
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'web-node.md'),
      makeStackFile('web-node', 'detection:\n  - package.json'),
    );
    writeFileSync(path.join(workRoot, 'package.json'), '{}');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, { stackOverride: [] });
    expect(result.active).toEqual(['web-node']);
    expect(result.issues).toEqual([]);
  });

  it('active-set union: overlapping detection rules activate every matching stack', () => {
    // Two stacks both detecting on `package.json`; both must activate.
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'web-node.md'),
      makeStackFile('web-node', 'detection:\n  - package.json'),
    );
    writeFileSync(
      path.join(stacksDir, 'extra-node.md'),
      makeStackFile('extra-node', 'detection:\n  - package.json'),
    );
    writeFileSync(path.join(workRoot, 'package.json'), '{}');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    expect(result.active).toEqual(['extra-node', 'web-node']);
  });

  it('malformed glob (empty string) fires MalformedInput and dispatch fails closed', () => {
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'broken.md'),
      // Empty pattern is rejected by picomatch v4 ("Expected pattern to be a
      // non-empty string"). Our determinism.glob propagates the throw; the
      // dispatcher catches it and emits MalformedInput.
      makeStackFile('broken', 'detection:\n  - ""'),
    );
    writeFileSync(path.join(workRoot, 'foo.txt'), 'irrelevant');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    // Failed-closed: stack does not activate; an issue is emitted.
    expect(result.active).toEqual([]);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    expect(result.issues[0].code).toBe('MalformedInput');
    expect(result.issues[0].field).toBe('/detection');
  });

  it('override referencing unknown stack → MissingFile issue', () => {
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, { stackOverride: ['nonexistent'] });
    expect(result.active).toEqual([]);
    const missing = result.issues.find((i) => i.code === 'MissingFile');
    expect(missing).toBeTruthy();
    expect(missing!.field).toBe('/stack/override');
  });

  it('override-named stack overrides auto-detection (skips detection rules)', () => {
    // Two stacks, both with detection that would match; override only the
    // second. Auto-detection is skipped and only the named one activates.
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'auto-match.md'),
      makeStackFile('auto-match', 'detection:\n  - package.json'),
    );
    writeFileSync(
      path.join(stacksDir, 'forced.md'),
      // Forced stack's detection does NOT match.
      makeStackFile('forced', 'detection:\n  - never-existing-file'),
    );
    writeFileSync(path.join(workRoot, 'package.json'), '{}');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, { stackOverride: ['forced'] });
    expect(result.active).toEqual(['forced']);
  });

  it('detection: anyOf composite matches when any sub-pattern matches', () => {
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'web-node.md'),
      makeStackFile(
        'web-node',
        'detection:\n  - anyOf:\n      - package.json\n      - tsconfig.json',
      ),
    );
    writeFileSync(path.join(workRoot, 'tsconfig.json'), '{}');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    expect(result.active).toEqual(['web-node']);
  });

  it('detection: allOf composite requires every sub-pattern to match', () => {
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'kmp.md'),
      makeStackFile(
        'kmp',
        'detection:\n  - allOf:\n      - build.gradle.kts\n      - settings.gradle.kts',
      ),
    );
    writeFileSync(path.join(workRoot, 'build.gradle.kts'), '');
    // settings.gradle.kts deliberately absent → allOf fails.
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    expect(result.active).toEqual([]);
  });

  it('detection: scope-filtered glob does not match files outside scope', () => {
    // A detection glob like `src/**/package.json` shouldn't match a
    // package.json at the project root.
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'scoped.md'),
      makeStackFile('scoped', 'detection:\n  - "src/**/package.json"'),
    );
    writeFileSync(path.join(workRoot, 'package.json'), '{}');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    expect(result.active).toEqual([]);
  });

  it('detection: contains-block matches when target file contains a substring', () => {
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'contains-test.md'),
      makeStackFile(
        'contains-test',
        'detection:\n  - path: package.json\n    contains:\n      - "vite"\n      - "next"',
      ),
    );
    writeFileSync(path.join(workRoot, 'package.json'), '{"deps":{"vite":"^4"}}');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    expect(result.active).toEqual(['contains-test']);
  });
});
