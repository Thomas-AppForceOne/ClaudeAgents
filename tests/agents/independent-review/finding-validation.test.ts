/**
 * Reproduction-gate unit tests for `validateFindings`.
 *
 * Covers the four behaviours the sprint contract pins:
 * - a command finding with exit 0 is kept and summary.dropped stays unchanged;
 * - a command finding with non-zero exit is dropped, summary.dropped is
 *   incremented by one, and the drop ledger records the finding's id with
 *   reason "reproduction-failed";
 * - an inspection finding is passed through unchanged and the runner is NOT
 *   invoked for it (asserted via a spying runner that records calls);
 * - a mixed bundle keeps only the reproducing command finding plus every
 *   inspection finding, increments dropped by the number of dropped command
 *   findings, and recomputes the per-severity tallies from the kept set;
 * - an empty findings array is an identity (no calls, no drops).
 *
 * Each test constructs a fresh bundle locally so a mutation in one test
 * cannot leak into another, and asserts both the result shape and that the
 * input bundle's `findings` array is not mutated (a regression that would
 * surprise any caller that retains a reference to the original).
 */

import { describe, expect, it } from 'vitest';

import {
  validateFindings,
  type CommandFinding,
  type CommandRunner,
  type IndependentReviewBundle,
  type InspectionFinding,
} from '../../../src/agents/independent-review/index.js';

// A spying runner: records every invocation so a test can assert the runner
// was (or wasn't) called and with what command. The injectable runner is
// the whole point of the pure-function shape; a real shell runner is the
// orchestrator's responsibility, never this module's.
function spyRunner(exitByCommand: Record<string, number>): {
  runner: CommandRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: CommandRunner = (cmd) => {
    calls.push(cmd);
    const exitCode = exitByCommand[cmd] ?? 0;
    return { exitCode, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

function makeCommandFinding(overrides: Partial<CommandFinding> = {}): CommandFinding {
  return {
    id: 'cmd-default',
    severity: 'blocker',
    category: 'correctness',
    kind: 'command',
    file: 'src/x.ts',
    line: 10,
    description: 'a deterministic defect',
    suggestedCriterion: 'asserts the defect is fixed',
    reproductionCommand: 'echo default-reproduction',
    reproduced: true,
    ...overrides,
  };
}

function makeInspectionFinding(overrides: Partial<InspectionFinding> = {}): InspectionFinding {
  return {
    id: 'insp-default',
    severity: 'warning',
    category: 'concurrency',
    kind: 'inspection',
    file: 'src/y.ts',
    line: 20,
    description: 'a code-anchored claim',
    suggestedCriterion: 'asserts the claim is addressed',
    evidencePointer: 'src/y.ts:20 lock held across await',
    ...overrides,
  };
}

function makeBundle(findings: IndependentReviewBundle['findings']): IndependentReviewBundle {
  return {
    sprintNumber: 1,
    attemptLetter: 'A',
    contractRevision: 0,
    findings,
    // initial dropped is 0 in the reviewer's bundle; the gate increments it
    // as it drops findings. Every test starts here so the delta is the
    // observable.
    summary: { blockers: 0, warnings: 0, advisories: 0, dropped: 0 },
  };
}

describe('validateFindings — command finding reproduction gate', () => {
  it('keeps a command finding whose runner reports exit 0 and leaves summary.dropped unchanged', () => {
    const finding = makeCommandFinding({
      id: 'cmd-keep',
      reproductionCommand: 'echo ok',
    });
    const bundle = makeBundle([finding]);
    const { runner, calls } = spyRunner({ 'echo ok': 0 });

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toHaveLength(1);
    expect(result.bundle.findings[0]).toEqual(finding);
    expect(result.droppedReasons).toEqual([]);
    expect(result.bundle.summary.dropped).toBe(0);
    expect(result.bundle.summary.blockers).toBe(1);
    expect(calls).toEqual(['echo ok']);
  });

  it('drops a command finding whose runner reports a non-zero exit and records the id with reason reproduction-failed', () => {
    const finding = makeCommandFinding({
      id: 'cmd-drop',
      reproductionCommand: 'false',
    });
    const bundle = makeBundle([finding]);
    const { runner, calls } = spyRunner({ false: 1 });

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toHaveLength(0);
    expect(result.droppedReasons).toEqual([{ id: 'cmd-drop', reason: 'reproduction-failed' }]);
    expect(result.bundle.summary.dropped).toBe(1);
    expect(result.bundle.summary.blockers).toBe(0);
    expect(calls).toEqual(['false']);
  });
});

describe('validateFindings — inspection findings flow through untouched', () => {
  it('keeps an inspection finding unchanged regardless of runner behaviour', () => {
    const finding = makeInspectionFinding({ id: 'insp-passthrough' });
    const bundle = makeBundle([finding]);
    // A runner that would drop everything if called; the test asserts it
    // is NEVER called for an inspection finding, so the exit map's value
    // is structurally irrelevant.
    const { runner, calls } = spyRunner({});

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toHaveLength(1);
    expect(result.bundle.findings[0]).toEqual(finding);
    expect(result.droppedReasons).toEqual([]);
    expect(result.bundle.summary.dropped).toBe(0);
    expect(result.bundle.summary.warnings).toBe(1);
    // The load-bearing assertion: the runner was not invoked. Inspection
    // findings have no runnable reproduction; calling the runner for them
    // would defeat the role's purpose.
    expect(calls).toEqual([]);
  });
});

describe('validateFindings — mixed bundles', () => {
  it('keeps reproducing command + every inspection finding, drops only the non-reproducing command finding, and updates summary.dropped accordingly', () => {
    const passingCommand = makeCommandFinding({
      id: 'cmd-pass',
      severity: 'blocker',
      reproductionCommand: 'echo ok',
    });
    const failingCommand = makeCommandFinding({
      id: 'cmd-fail',
      severity: 'warning',
      reproductionCommand: 'false',
    });
    const inspection = makeInspectionFinding({
      id: 'insp-keep',
      severity: 'advisory',
    });
    const bundle = makeBundle([passingCommand, failingCommand, inspection]);
    const { runner, calls } = spyRunner({ 'echo ok': 0, false: 1 });

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toHaveLength(2);
    expect(result.bundle.findings.map((f) => f.id)).toEqual(['cmd-pass', 'insp-keep']);
    expect(result.droppedReasons).toEqual([{ id: 'cmd-fail', reason: 'reproduction-failed' }]);
    expect(result.bundle.summary.dropped).toBe(1);
    expect(result.bundle.summary.blockers).toBe(1);
    expect(result.bundle.summary.warnings).toBe(0);
    expect(result.bundle.summary.advisories).toBe(1);
    // The runner is called exactly once per command finding, in order,
    // and never for the inspection finding.
    expect(calls).toEqual(['echo ok', 'false']);
  });

  it('preserves the initial summary.dropped cumulative count when adding new drops', () => {
    // A bundle whose reviewer already reported a prior drop count: the
    // gate adds new drops to that running total rather than overwriting
    // it, so a downstream re-validation pass cannot accidentally rewind
    // the dropped tally to 0.
    const failingCommand = makeCommandFinding({
      id: 'cmd-fail',
      reproductionCommand: 'false',
    });
    const bundle: IndependentReviewBundle = {
      ...makeBundle([failingCommand]),
      summary: { blockers: 0, warnings: 0, advisories: 0, dropped: 7 },
    };
    const { runner } = spyRunner({ false: 1 });

    const result = validateFindings(bundle, runner);

    expect(result.bundle.summary.dropped).toBe(8);
  });
});

describe('validateFindings — empty bundles', () => {
  it('returns an empty kept-findings list and an empty drop ledger for an empty input', () => {
    const bundle = makeBundle([]);
    const { runner, calls } = spyRunner({});

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toEqual([]);
    expect(result.droppedReasons).toEqual([]);
    expect(result.bundle.summary).toEqual({
      blockers: 0,
      warnings: 0,
      advisories: 0,
      dropped: 0,
    });
    expect(calls).toEqual([]);
  });
});

describe('validateFindings — runner-boundary failure modes', () => {
  it('drops a command finding whose reproductionCommand carries shell metacharacters and records reproduction-unsafe without invoking the runner', () => {
    const finding = makeCommandFinding({
      id: 'cmd-unsafe',
      reproductionCommand: 'echo ok; rm -rf /',
    });
    const bundle = makeBundle([finding]);
    // A runner that throws if called: pins the load-bearing assertion
    // that the gate refuses unsafe input at its own boundary rather
    // than delegating the refusal to the runner contract.
    const calls: string[] = [];
    const runner: CommandRunner = (cmd) => {
      calls.push(cmd);
      throw new Error('runner must not be invoked for an unsafe command');
    };

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toHaveLength(0);
    expect(result.droppedReasons).toEqual([
      { id: 'cmd-unsafe', reason: 'reproduction-unsafe' },
    ]);
    expect(result.bundle.summary.dropped).toBe(1);
    // The load-bearing assertion: the runner is never called for an
    // unsafe command. The gate refuses at the boundary rather than
    // trust-relabelling the docblock's "schema validation ran" claim.
    expect(calls).toEqual([]);
  });

  it('drops a command finding whose runner throws synchronously and continues the walk', () => {
    const throwing = makeCommandFinding({
      id: 'cmd-throws',
      reproductionCommand: 'echo throws',
    });
    const surviving = makeCommandFinding({
      id: 'cmd-survives',
      reproductionCommand: 'echo ok',
    });
    const bundle = makeBundle([throwing, surviving]);
    const calls: string[] = [];
    const runner: CommandRunner = (cmd) => {
      calls.push(cmd);
      if (cmd === 'echo throws') throw new Error('confinement violation');
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const result = validateFindings(bundle, runner);

    // Load-bearing: the throw does NOT abort the walk; the surviving
    // finding is kept, the throwing one is recorded with
    // reproduction-errored.
    expect(result.bundle.findings.map((f) => f.id)).toEqual(['cmd-survives']);
    expect(result.droppedReasons).toEqual([
      { id: 'cmd-throws', reason: 'reproduction-errored' },
    ]);
    expect(result.bundle.summary.dropped).toBe(1);
    expect(calls).toEqual(['echo throws', 'echo ok']);
  });

  it('preserves original order when the middle finding throws, ledgering each verdict correctly', () => {
    // Pins the regression I-004 describes: a throw must not silently
    // truncate the suffix of the walk. Three command findings; the
    // middle one throws; the first and third are adjudicated normally.
    const first = makeCommandFinding({
      id: 'cmd-a',
      reproductionCommand: 'echo a',
    });
    const middle = makeCommandFinding({
      id: 'cmd-b',
      reproductionCommand: 'echo b',
    });
    const last = makeCommandFinding({
      id: 'cmd-c',
      reproductionCommand: 'echo c',
    });
    const bundle = makeBundle([first, middle, last]);
    const runner: CommandRunner = (cmd) => {
      if (cmd === 'echo b') throw new Error('spawn EAGAIN');
      return { exitCode: cmd === 'echo c' ? 1 : 0, stdout: '', stderr: '' };
    };

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings.map((f) => f.id)).toEqual(['cmd-a']);
    expect(result.droppedReasons).toEqual([
      { id: 'cmd-b', reason: 'reproduction-errored' },
      { id: 'cmd-c', reason: 'reproduction-failed' },
    ]);
    expect(result.bundle.summary.dropped).toBe(2);
  });
});

describe('validateFindings — does not mutate its input', () => {
  it('the input bundle.findings array is unchanged after the call', () => {
    const passing = makeCommandFinding({ id: 'a', reproductionCommand: 'echo ok' });
    const failing = makeCommandFinding({ id: 'b', reproductionCommand: 'false' });
    const inspection = makeInspectionFinding({ id: 'c' });
    const bundle = makeBundle([passing, failing, inspection]);
    const beforeFindings = bundle.findings.slice();
    const beforeSummary = { ...bundle.summary };
    const { runner } = spyRunner({ 'echo ok': 0, false: 1 });

    validateFindings(bundle, runner);

    // The original bundle's finding list and summary remain byte-equal to
    // the snapshot taken before the call; any mutation would silently
    // surprise a caller that retained a reference to the input.
    expect(bundle.findings).toEqual(beforeFindings);
    expect(bundle.summary).toEqual(beforeSummary);
  });
});
