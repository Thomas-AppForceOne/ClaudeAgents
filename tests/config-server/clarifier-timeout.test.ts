// Validation tests for the clarifier.draftTimeoutSeconds overlay field, run
// through the full validateAll path so the wiring (not just the check in
// isolation) is exercised. Two layers are guarded, and the test asserts they do
// NOT overlap:
//   - The [10, 600] BOUND is a semantic constraint: an integer outside the
//     range (including 0) must surface as InvalidTimeoutValue, not as a generic
//     SchemaMismatch. Boundary values 10 and 600 accept clean; 9 and 601 reject;
//     0 rejects. Both the bare value and the cascade wrapper { value: N } forms
//     are checked on the reject path.
//   - The integer TYPE is a schema constraint: a non-integer is a shape fault
//     the schema reports as SchemaMismatch, and the range check must stay silent
//     for it so the two layers never double-report the same field.
// An overlay omitting the field validates clean (the seed default of 60 then
// applies downstream). Per the repo error-text contract, the InvalidTimeoutValue
// message names the field and the valid range and leaks no validator-library or
// runtime token.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../src/config-server/tools/validate.js';
import { clearResolvedConfigCache } from '../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const jsTsMinimalSrc = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const tmpDirs: string[] = [];

// Build an isolated project (copied from a clean fixture) plus an empty user
// home, then write the supplied project-overlay body. Returns the inputs
// validateAll needs. The fixture copy keeps each case hermetic.
function makeProjectWithOverlay(projectOverlayBody: string): {
  projectRoot: string;
  userHome: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'clarifier-timeout-'));
  const projectRoot = path.join(root, 'project');
  const userHome = path.join(root, 'home');
  cpSync(jsTsMinimalSrc, projectRoot, { recursive: true });
  mkdirSync(path.join(userHome, '.claude', 'gan'), { recursive: true });
  const overlayPath = path.join(projectRoot, '.claude', 'gan', 'project.md');
  mkdirSync(path.dirname(overlayPath), { recursive: true });
  writeFileSync(overlayPath, projectOverlayBody);
  tmpDirs.push(root);
  return { projectRoot, userHome };
}

function validateWithClarifierBlock(clarifierYaml: string): ReturnType<typeof validateAll> {
  const { projectRoot, userHome } = makeProjectWithOverlay(
    `---\nschemaVersion: 1\n${clarifierYaml}---\n`,
  );
  return validateAll({ projectRoot }, { userHome });
}

beforeEach(() => clearResolvedConfigCache());

afterEach(() => {
  clearResolvedConfigCache();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('clarifier.draftTimeoutSeconds — out-of-range reject (InvalidTimeoutValue)', () => {
  it('rejects 0 (bare) with InvalidTimeoutValue, not SchemaMismatch', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 0\n');
    const timeoutIssues = result.issues.filter((i) => i.code === 'InvalidTimeoutValue');
    expect(timeoutIssues).toHaveLength(1);
    expect(result.issues.some((i) => i.code === 'SchemaMismatch')).toBe(false);
    const issue = timeoutIssues[0];
    expect(issue.severity).toBe('error');
    expect(issue.field).toBe('/clarifier/draftTimeoutSeconds');
  });

  it('rejects 9 (just below the lower bound, bare)', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 9\n');
    expect(result.issues.filter((i) => i.code === 'InvalidTimeoutValue')).toHaveLength(1);
  });

  it('rejects 601 (just above the upper bound, bare)', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 601\n');
    expect(result.issues.filter((i) => i.code === 'InvalidTimeoutValue')).toHaveLength(1);
  });

  it('rejects 0 in the cascade wrapper { discardInherited, value } form', () => {
    const result = validateWithClarifierBlock(
      'clarifier:\n  draftTimeoutSeconds:\n    discardInherited: false\n    value: 0\n',
    );
    const timeoutIssues = result.issues.filter((i) => i.code === 'InvalidTimeoutValue');
    expect(timeoutIssues).toHaveLength(1);
    expect(result.issues.some((i) => i.code === 'SchemaMismatch')).toBe(false);
  });

  it('rejects 700 in the wrapper form (out-of-range, value path)', () => {
    const result = validateWithClarifierBlock(
      'clarifier:\n  draftTimeoutSeconds:\n    discardInherited: true\n    value: 700\n',
    );
    expect(result.issues.filter((i) => i.code === 'InvalidTimeoutValue')).toHaveLength(1);
  });
});

describe('clarifier.draftTimeoutSeconds — in-range / absent accept', () => {
  it('accepts the lower boundary 10 with no issue', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 10\n');
    expect(result.issues).toEqual([]);
  });

  it('accepts the upper boundary 600 with no issue', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 600\n');
    expect(result.issues).toEqual([]);
  });

  it('accepts the default value 60 with no issue', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 60\n');
    expect(result.issues).toEqual([]);
  });

  it('accepts an overlay omitting the field entirely (default applies downstream)', () => {
    const { projectRoot, userHome } = makeProjectWithOverlay('---\nschemaVersion: 1\n---\n');
    const result = validateAll({ projectRoot }, { userHome });
    expect(result.issues).toEqual([]);
  });
});

describe('clarifier.draftTimeoutSeconds — type fault stays with the schema layer', () => {
  it('a non-integer (string) is SchemaMismatch, never InvalidTimeoutValue', () => {
    const result = validateWithClarifierBlock("clarifier:\n  draftTimeoutSeconds: 'sixty'\n");
    expect(result.issues.some((i) => i.code === 'SchemaMismatch')).toBe(true);
    expect(result.issues.some((i) => i.code === 'InvalidTimeoutValue')).toBe(false);
  });

  it('a non-integer (float) is SchemaMismatch, never InvalidTimeoutValue', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 5.5\n');
    expect(result.issues.some((i) => i.code === 'SchemaMismatch')).toBe(true);
    expect(result.issues.some((i) => i.code === 'InvalidTimeoutValue')).toBe(false);
  });
});

describe('clarifier.draftTimeoutSeconds — InvalidTimeoutValue message is user-facing', () => {
  it('names the field and the valid range and leaks no library/runtime token', () => {
    const result = validateWithClarifierBlock('clarifier:\n  draftTimeoutSeconds: 0\n');
    const issue = result.issues.find((i) => i.code === 'InvalidTimeoutValue');
    expect(issue).toBeTruthy();
    const message = issue!.message;
    expect(message).toContain('draftTimeoutSeconds');
    expect(message).toContain('10');
    expect(message).toContain('600');
    const lower = message.toLowerCase();
    for (const token of ['ajv', 'npm', 'node', 'vitest', 'yarn', 'pnpm']) {
      expect(lower).not.toContain(token);
    }
  });
});
