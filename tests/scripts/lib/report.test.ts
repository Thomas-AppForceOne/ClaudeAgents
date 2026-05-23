/**
 * Unit tests for the shared report formatters every CLI bin uses to print its
 * outcome: `formatReport` (human-readable summary on stdout + per-failure
 * detail on stderr) and `formatReportJson` (machine-readable, sorted-key,
 * two-space-indented JSON).
 *
 * The tests pin the exact contract callers and CI depend on: the stdout
 * summary line and its trailing newline, the "failed" count being unique
 * FILES rather than raw failure entries, stderr carrying path/code/message for
 * each failure, and the JSON form having stable key ordering plus a
 * round-trippable `{ checked, failed, failures[] }` shape.
 *
 * Regression guarded: drift in the summary wording, the unique-file counting,
 * or the JSON key order/shape would break downstream parsers and the bins'
 * golden-output assertions.
 */

import { describe, expect, it } from 'vitest';
import {
  formatReport,
  formatReportJson,
  type LintStacksReport,
  type ReportFailure,
} from '../../../scripts/lib/index.js';

// Two failures on DIFFERENT files, reused across cases to exercise both the
// multi-file and same-file counting paths.
const FAILURE_A: ReportFailure = {
  path: '/abs/proj/stacks/web-node.md',
  code: 'ScaffoldBannerPresent',
  message: 'Stack file still carries the scaffold DRAFT banner.',
};

const FAILURE_B: ReportFailure = {
  path: '/abs/proj/stacks/other.md',
  code: 'SchemaMismatch',
  message: 'Other failure message.',
};

describe('formatReport (lint-stacks)', () => {
  it('zero-failure run: stdout summary, empty stderr', () => {
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 3,
      failures: [],
    };
    const out = formatReport(report);
    expect(out.stdout).toBe('3 stacks checked, 0 failed\n');
    expect(out.stderr).toBe('');
  });

  it('zero-checked, zero-failure: still prints summary with trailing newline', () => {
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 0,
      failures: [],
    };
    const out = formatReport(report);
    expect(out.stdout).toBe('0 stacks checked, 0 failed\n');
    expect(out.stderr).toBe('');
  });

  it('one-failure run: stderr names the path, code, and message', () => {
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 1,
      failures: [FAILURE_A],
    };
    const out = formatReport(report);
    expect(out.stdout).toBe('1 stacks checked, 1 failed\n');
    expect(out.stderr).toContain(FAILURE_A.path);
    expect(out.stderr).toContain(FAILURE_A.code);
    expect(out.stderr).toContain(FAILURE_A.message);
    expect(out.stderr.endsWith('\n')).toBe(true);
  });

  it('multiple failures across files: counts unique files as failed', () => {
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 2,
      failures: [FAILURE_A, FAILURE_B],
    };
    const out = formatReport(report);
    expect(out.stdout).toBe('2 stacks checked, 2 failed\n');

    const lines = out.stderr.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(FAILURE_A.path);
    expect(lines[1]).toContain(FAILURE_B.path);
  });

  it('multiple failures on the same file: counts the file once', () => {
    // Two failures sharing one path: the summary counts 1 failed FILE, but
    // stderr still lists both individual issues.
    const second: ReportFailure = {
      path: FAILURE_A.path,
      code: 'SchemaMismatch',
      message: 'Same file, second issue.',
    };
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 1,
      failures: [FAILURE_A, second],
    };
    const out = formatReport(report);

    expect(out.stdout).toBe('1 stacks checked, 1 failed\n');
    const lines = out.stderr.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
  });
});

describe('formatReportJson (lint-stacks)', () => {
  it('emits sorted-key two-space-indent JSON with trailing newline', () => {
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 1,
      failures: [FAILURE_A],
    };
    const json = formatReportJson(report);
    expect(json.endsWith('\n')).toBe(true);

    // Two-space indent at top level (the leading-newline anchors confirm the
    // pretty-print width).
    expect(json).toContain('\n  "checked": 1');
    expect(json).toContain('\n  "failed": 1');

    // Keys are emitted in sorted order; assert by relative index so the test
    // is robust to whitespace: code < message < path alphabetically.
    const codeIdx = json.indexOf('"code"');
    const messageIdx = json.indexOf('"message"');
    const pathIdx = json.indexOf('"path"');
    expect(codeIdx).toBeGreaterThan(0);
    expect(codeIdx).toBeLessThan(messageIdx);
    expect(messageIdx).toBeLessThan(pathIdx);
  });

  it('round-trips through JSON.parse to the documented shape', () => {
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 2,
      failures: [FAILURE_A, FAILURE_B],
    };
    const parsed = JSON.parse(formatReportJson(report)) as {
      checked: number;
      failed: number;
      failures: Array<{ path: string; code: string; message: string }>;
    };
    expect(parsed.checked).toBe(2);
    expect(parsed.failed).toBe(2);
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0]!.code).toBe(FAILURE_A.code);
    expect(parsed.failures[0]!.path).toBe(FAILURE_A.path);
    expect(parsed.failures[1]!.code).toBe(FAILURE_B.code);
  });

  it('empty failures: the failures array is present and empty', () => {
    const report: LintStacksReport = {
      kind: 'lint-stacks',
      checked: 0,
      failures: [],
    };
    const parsed = JSON.parse(formatReportJson(report)) as {
      checked: number;
      failed: number;
      failures: unknown[];
    };
    expect(parsed.checked).toBe(0);
    expect(parsed.failed).toBe(0);
    expect(parsed.failures).toEqual([]);
  });
});
