// Covers detectActiveStacks — the C2 dispatch that decides which stacks are
// active for a project. Two paths are pinned here:
//   1. an explicit, non-empty stack.override short-circuits detection (the
//      named stacks win, auto-detection is skipped, and an override naming an
//      unknown stack is a MissingFile issue);
//   2. with no/empty override, every stack whose detection rules match the
//      project files activates (the active set is a union, sorted by name).
// It also exercises the detection rule grammar: bare globs, anyOf/allOf
// composites, scope-filtered globs, and contains-blocks; and the fail-closed
// behaviour where a malformed glob yields a MalformedInput issue and an empty
// active set rather than throwing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { detectActiveStacks } from '../../../src/config-server/resolution/detection.js';
import { _runPhase1ForTests } from '../../../src/config-server/tools/validate.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';

// Minimal valid project overlay (empty YAML body, just the schema pin).
const STUB_OVERLAY = ['---', 'schemaVersion: 1', '---', '', ''].join('\n');

// Builds a stack file with the given name and a YAML body fragment. The body
// is trimmed so callers can pass an indented multi-line `detection:` block
// without leaking leading/trailing blank lines into the frontmatter.
function makeStackFile(name: string, body: string): string {
  return ['---', `name: ${name}`, 'schemaVersion: 1', body.trim(), '---', '', ''].join('\n');
}

// Runs the real phase-1 scan to build a validation snapshot, then fills in each
// stack file's parsed `data`/`prose` so detectActiveStacks sees fully hydrated
// rows (phase 1 records the file paths but does not parse their bodies).
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

    mkdirSync(path.join(workRoot, '.claude', 'gan'), { recursive: true });
    writeFileSync(path.join(workRoot, '.claude', 'gan', 'project.md'), STUB_OVERLAY);
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('non-empty stack.override → exactly that list, no auto-detection', () => {
    // Neither stack's detection rule matches (no package.json/Dockerfile on
    // disk), so the resulting active set proves the override won, not
    // detection. The output is name-sorted, hence docker before web-node.
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

    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, { stackOverride: ['web-node', 'docker'] });
    expect(result.active).toEqual(['docker', 'web-node']);
    expect(result.issues).toEqual([]);
  });

  it('empty stack.override after cascade → run auto-detection', () => {
    // An empty override (the post-cascade default) does not suppress
    // detection; the package.json on disk activates web-node.
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
    // Two stacks share the same detection trigger (package.json); both must
    // activate — detection is a union, not first-match-wins.
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

      makeStackFile('broken', 'detection:\n  - ""'),
    );
    writeFileSync(path.join(workRoot, 'foo.txt'), 'irrelevant');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});

    // Fail-closed: a malformed glob produces no active stacks and a
    // MalformedInput issue pointing at the /detection field, rather than
    // throwing or matching everything.
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
    // auto-match WOULD detect (package.json exists) but is not in the override;
    // forced WOULD NOT detect (its file is absent) but is named. The override
    // wins both ways: only `forced` is active, auto-match is suppressed.
    const stacksDir = path.join(workRoot, 'stacks');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      path.join(stacksDir, 'auto-match.md'),
      makeStackFile('auto-match', 'detection:\n  - package.json'),
    );
    writeFileSync(
      path.join(stacksDir, 'forced.md'),

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
    // Only one of the two allOf sub-patterns is present, so allOf must NOT
    // match — the stack stays inactive.
    writeFileSync(path.join(workRoot, 'build.gradle.kts'), '');

    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    expect(result.active).toEqual([]);
  });

  it('detection: scope-filtered glob does not match files outside scope', () => {
    // The glob requires package.json under src/, but the file sits at the root;
    // the scope prefix must prevent a match.
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
    // The file contains "vite" (one of the listed substrings), which is
    // sufficient for a contains-block to match.
    writeFileSync(path.join(workRoot, 'package.json'), '{"deps":{"vite":"^4"}}');
    const snapshot = hydrateSnapshot(workRoot);
    const result = detectActiveStacks(snapshot, {});
    expect(result.active).toEqual(['contains-test']);
  });
});
