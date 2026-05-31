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

// ---------------------------------------------------------------------------
// Negative-shape contract suites (cluster C-5 / I-010).
//
// Each describe block below pins one of the gate's documented negative-shape
// promises so a future "defensive narrowing" or "silent recovery" edit
// surfaces as a named test failure rather than a behaviour change shipped
// invisibly. The positive-path suites above answer "what does the gate
// produce on the happy path"; these suites answer "what does the gate
// promise NOT to do".
// ---------------------------------------------------------------------------

describe('validateFindings — negative-shape contract — runner exceptions', () => {
  it('does not crash the gate when the injected runner throws synchronously', () => {
    // The load-bearing assertion: a sync-throwing runner is a documented
    // failure mode (finding-validation.ts:81-86, "throws propagate from
    // neither path"). The call must complete normally — no thrown error
    // escapes — and the kept/dropped invariants must still hold so the
    // walk's result remains observable by the orchestrator.
    const onlyFinding = makeCommandFinding({
      id: 'cmd-throws-solo',
      reproductionCommand: 'echo throws',
    });
    const bundle = makeBundle([onlyFinding]);
    const runner: CommandRunner = () => {
      throw new Error('spawn EAGAIN');
    };

    // No-crash guard + result capture in a single invocation: try/catch
    // records "did it throw?" without re-invoking the gate (which would
    // double-record the throw / kept-dropped tallies).
    let threw: unknown;
    let result: ReturnType<typeof validateFindings> | undefined;
    try {
      result = validateFindings(bundle, runner);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
    expect(result).toBeDefined();

    // Kept/dropped invariants: every finding lands in exactly one of
    // (kept, dropped); the sum equals the input count. A truncated walk
    // would leave a finding in neither bucket and break this invariant.
    expect(result!.bundle.findings).toHaveLength(0);
    expect(result!.droppedReasons).toHaveLength(1);
    expect(
      result!.bundle.findings.length + result!.droppedReasons.length,
    ).toBe(bundle.findings.length);
    expect(result!.bundle.summary.dropped).toBe(1);
    expect(result!.bundle.summary.blockers).toBe(0);
  });

  it('maps a sync-throw to the reproduction-errored drop reason verbatim (contract pin post Step 3)', () => {
    // Pins the contract Step 3 established: a synchronously-throwing
    // runner is no longer a propagated throw — the gate catches per
    // finding and records `reproduction-errored`. A test that asserted
    // ".toThrow(oops)" here (the pre-Step-3 shape) is now incorrect; this
    // test pins the post-Step-3 semantics so a regression that re-removes
    // the try/catch fails with a named contract pin rather than a
    // surprising verbatim throw.
    const finding = makeCommandFinding({
      id: 'cmd-errored',
      reproductionCommand: 'echo whatever',
    });
    const bundle = makeBundle([finding]);
    const oops = new Error('confinement violation');
    const runner: CommandRunner = () => {
      throw oops;
    };

    const result = validateFindings(bundle, runner);

    expect(result.droppedReasons).toEqual([
      { id: 'cmd-errored', reason: 'reproduction-errored' },
    ]);
    // The original error object is NOT exposed to the caller — by design
    // (the docblock promises "throws propagate from neither path"). A
    // future regression that put the message into the ledger would still
    // pass this assertion; the assertion's role is to pin the no-throw
    // contract, not to police the loss of the message itself.
  });
});

describe('validateFindings — negative-shape contract — exit-code polarity', () => {
  // Pins the load-bearing polarity at `finding-validation.ts:161`:
  // `if (result.exitCode === 0) keep` — every other value drops with
  // `reproduction-failed`. The positive-path suites above cover the happy
  // values `0` and `1`; this suite covers the long tail (`-1`, `2`, `0.5`,
  // `NaN`, `undefined`, `null` cast through `as unknown as ...`) so a
  // regression that flipped to `!== 1` or `< 1` would fail here rather
  // than ship.
  it.each<[string, unknown]>([
    ['negative exit code -1', -1],
    ['large positive exit code 2', 2],
    ['fractional exit code 0.5', 0.5],
    ['NaN exit code', Number.NaN],
    ['undefined exit code', undefined],
    ['null exit code (cast through as unknown as)', null],
  ])('drops the finding with reproduction-failed when the runner reports %s', (_, exitValue) => {
    const finding = makeCommandFinding({
      id: 'cmd-polarity',
      reproductionCommand: 'echo polarity',
    });
    const bundle = makeBundle([finding]);
    const runner: CommandRunner = () => {
      // The runner returns whatever the orchestrator-side wire would
      // hand the gate; the type cast pins the "we run schema-validation
      // upstream but the wire is fundamentally unknown" boundary.
      return { exitCode: exitValue as unknown as number, stdout: '', stderr: '' };
    };

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toHaveLength(0);
    expect(result.droppedReasons).toEqual([
      { id: 'cmd-polarity', reason: 'reproduction-failed' },
    ]);
    expect(result.bundle.summary.dropped).toBe(1);
  });

  it('keeps the finding when the runner reports exitCode === 0 (the only kept polarity)', () => {
    // Symmetric pin: the ONLY value that keeps is exactly `0`. A test
    // matrix without the positive case would let a regression to
    // `!== 0` (which keeps every non-zero, drops only zero) sneak by
    // the polarity suite — this test prevents that.
    const finding = makeCommandFinding({
      id: 'cmd-polarity-keep',
      reproductionCommand: 'echo zero',
    });
    const bundle = makeBundle([finding]);
    const runner: CommandRunner = () => ({ exitCode: 0, stdout: '', stderr: '' });

    const result = validateFindings(bundle, runner);

    expect(result.bundle.findings).toHaveLength(1);
    expect(result.droppedReasons).toEqual([]);
  });
});

describe('validateFindings — negative-shape contract — schema trust', () => {
  it('does not throw on a malformed bundle missing the kind discriminator (pins current trust-upstream behaviour)', () => {
    // The post-Step-3 docblock truthfully enumerates the gate's verdicts:
    // `{kept, reproduction-failed, reproduction-unsafe, reproduction-errored}`
    // with "throws propagate from neither path". The gate still trusts
    // the schema upstream for the discriminator field; a finding without
    // `kind` does NOT match the inspection branch (`finding.kind ===
    // 'inspection'` is false), so it falls through to the command branch
    // and the runner is invoked on its (possibly undefined)
    // `reproductionCommand`. The test pins THAT — deterministic handling
    // of a malformed input — rather than a TypeError surface. A future
    // regression that re-introduces a defensive `if (finding.kind !==
    // 'command' && finding.kind !== 'inspection') throw …` would fail
    // this assertion as a contract change, which is the right signal.
    const malformed = {
      id: 'malformed-no-kind',
      severity: 'blocker' as const,
      category: 'correctness' as const,
      file: 'src/x.ts',
      line: 10,
      description: 'malformed: no kind discriminator',
      suggestedCriterion: 'asserts something',
      // No `kind`, no `reproductionCommand`, no `reproduced`. The cast
      // smuggles the malformed shape past the type checker the same way
      // an unvalidated wire bundle would.
    } as unknown as CommandFinding;
    const bundle = makeBundle([malformed]);
    const { runner, calls } = spyRunner({});

    // No-crash guard + result capture in a single invocation: calling
    // `validateFindings` twice (once inside `expect(...).not.toThrow()`
    // and once for the result) would double-count the runner spy. The
    // try/catch pattern below records "did it throw?" without
    // re-invoking the gate.
    let threw: unknown;
    let result: ReturnType<typeof validateFindings> | undefined;
    try {
      result = validateFindings(bundle, runner);
    } catch (e) {
      threw = e;
    }

    // Pins the gate's docblock promise (no throws from the four
    // enumerated paths) covers a missing-discriminator input too.
    expect(threw).toBeUndefined();
    expect(result).toBeDefined();

    // The runner is invoked once (the malformed finding falls into the
    // command branch). The `reproductionCommand` is `undefined`; the
    // gate's UNSAFE_COMMAND_CHARACTERS regex coerces it to the string
    // "undefined" which contains none of the banned characters, so the
    // runner is reached.
    expect(calls).toHaveLength(1);
    // The spyRunner default returns exitCode 0 for any command, so the
    // malformed finding is kept under the current (post-Step-3)
    // behaviour. The test is asserting the gate's actual deterministic
    // verdict, not a hypothetical "we should reject this" contract.
    expect(result?.bundle.findings).toHaveLength(1);
    expect(result?.droppedReasons).toEqual([]);
  });
});
