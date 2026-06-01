// Conformance tests for the strict `progress-v1` schema. The schema is the
// orchestrator's `progress.json` reconciliation surface: every field the
// orchestrator writes must be enumerated under `properties`, and the
// `additionalProperties:false` posture makes any unenumerated field a
// validation error rather than a silent accept. The negative cases below pin
// that strictness; the positive cases pin the load-bearing fields the E8
// writer ships before this schema lands.
//
// The fixture under tests/fixtures/progress/ is a hand-crafted placeholder
// pending a real capture from an E8-renegotiated dogfood run — see the README
// alongside it for the deferred-capture handoff. The placeholder is enough to
// exercise the schema's strictness today; the dogfood is what makes the gate
// reconcile against real writer output.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AjvImport, { type ValidateFunction } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';

import { progressV1 } from '../../src/config-server/schemas-bundled.js';
import {
  recordWorkspace,
  seedProgress,
  type RunContextForSeed,
} from '../../src/config-server/storage/run-progress.js';
import { writeProgressFields } from '../../src/agents/independent-review/progress.js';
import { buildFailedEvaluationRejectedRecord } from '../../src/agents/independent-review/terminal-reason.js';
import { buildLoopHaltTerminalRecord } from '../../src/safety/recovery.js';
import { validateProgress } from '../../src/config-server/validation/schema-check.js';
import type { ResolvedWorkspace } from '../../src/config-server/storage/worktree-resolver.js';

// Read the fixture from disk rather than importing it, matching the existing
// pattern in tests/config-server/schemas-bundled-independent-review.test.ts.
// The on-disk file is the canonical source for the reconciliation-gate
// fixture; readFileSync also avoids the JSON-import-attribute pathway, which
// the rest of the test surface does not exercise.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, '..', 'fixtures', 'progress', 'progress-v1-e8-renegotiated.json');
const e8RenegotiatedFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
  string,
  unknown
>;

// Ajv ships as a CJS module whose constructor may live on `.default` under an
// ESM interop shim or directly on the namespace; normalise both forms to one
// callable constructor. Matches the project's existing Ajv-loader idiom in
// src/config-server/validation/schema-check.ts.
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

// Compile under the same Ajv settings the rest of the project uses for the
// bundled-schema validators (strict:true, allErrors:true, useDefaults:false).
// Strict mode means a schema misuse during authoring throws at compile time,
// not silently at validation time, so the compilation step itself is part of
// the contract this suite pins.
function compile(): ValidateFunction {
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  return ajv.compile(progressV1);
}

// The full enumerated `terminalReason` set from O2 spec section 2. Read from
// the schema's own `definitions.terminalReasonCode.enum` rather than re-typed
// here so adding an 11th value is a one-line schema edit and the positive-
// coverage loop below picks it up automatically — drift between the schema's
// enum and the test's coverage is itself a finding. The cast is the same
// opaque-JSON narrowing the rest of the file uses.
const TERMINAL_REASONS = (
  progressV1 as { definitions: { terminalReasonCode: { enum: readonly string[] } } }
).definitions.terminalReasonCode.enum;

// A minimal in-flight shape every test can spread. terminal:false +
// terminalReason:null + terminalAt:null is the legal "not yet ended" tuple;
// individual tests mutate one field at a time so the rejection (or acceptance)
// is attributable to that mutation alone.
function inFlightBase(): Record<string, unknown> {
  return {
    runId: '20260512T094233-7c1a',
    status: 'building',
    currentSprint: 2,
    currentAttempt: 1,
    contractRevision: 0,
    totalSprints: 5,
    completedSprints: 1,
    projectRoot: '/Users/example/projects/sample-app',
    runBranch: 'gan/20260512T094233-7c1a',
    baseBranch: 'develop',
    startingBranch: 'develop',
    workspace: {
      worktreePath:
        '/Users/example/projects/sample-app/.gan-state/runs/20260512T094233-7c1a/worktree',
      branch: 'gan/20260512T094233-7c1a',
      createdByGan: true,
    },
    terminal: false,
    terminalReason: null,
    terminalAt: null,
    overlaysAtSnapshot: {
      user: { loaded: true, path: '/Users/example/.claude/gan/user.md', hash: 'sha256:abc' },
      project: { loaded: true, path: '.claude/gan/project.md', hash: 'sha256:def' },
    },
    recoveryHistory: [],
  };
}

describe('progress-v1 schema compiles cleanly under the project Ajv settings', () => {
  it('compiles without throwing in strict mode', () => {
    // Strict Ajv would throw at compile time on a schema misuse (an unknown
    // keyword, a sibling-of-$ref conflict, etc.), so the act of compiling is
    // part of the contract — not just a setup step.
    expect(() => compile()).not.toThrow();
  });
});

describe('progress-v1 schema accepts a captured E8-renegotiated run', () => {
  const validate = compile();

  it('validates the deferred-capture fixture verbatim', () => {
    // The fixture carries `contractRevision: 2` and
    // `terminalReason: failed-evaluation-rejected` — the two E8-writer fields
    // the schema must accept or every renegotiated run fails CI. Per the
    // sibling README, a real capture replaces this placeholder during the
    // release-gate dogfood; today's assertion proves the schema's shape.
    const ok = validate(e8RenegotiatedFixture);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it('records `contractRevision > 0` in the fixture (E8 writer field)', () => {
    // Pin the fixture's E8-seam value here so a future maintainer who
    // "tidies" the fixture cannot inadvertently zero out the renegotiated
    // signal the reconciliation-gate test depends on.
    const cr = e8RenegotiatedFixture.contractRevision as number;
    expect(typeof cr).toBe('number');
    expect(cr).toBeGreaterThan(0);
  });

  it('records `terminalReason: failed-evaluation-rejected` in the fixture (E8 writer value)', () => {
    // Same pinning rationale as the previous test, scoped to the second
    // E8-writer field. The two assertions are sister checks.
    expect(e8RenegotiatedFixture.terminalReason).toBe('failed-evaluation-rejected');
  });
});

describe('progress-v1 schema accepts each enumerated terminalReason value', () => {
  const validate = compile();

  for (const reason of TERMINAL_REASONS) {
    it(`accepts terminalReason: "${reason}"`, () => {
      // Each named outcome is paired with `terminal:true` and a populated
      // `terminalAt`, the tuple O2 section 3 specifies for a teardown writer.
      const candidate = {
        ...inFlightBase(),
        terminal: true,
        terminalReason: reason,
        terminalAt: '2026-05-12T10:18:47.512Z',
      };
      const ok = validate(candidate);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    });
  }

  it('accepts terminalReason: null on an in-flight run', () => {
    // The null branch of the `terminalReason` anyOf — the in-flight tuple
    // (terminal:false / terminalReason:null / terminalAt:null) is the shape
    // every run carries until teardown.
    expect(validate(inFlightBase())).toBe(true);
  });
});

describe('progress-v1 schema accepts the legacy workspace shape', () => {
  const validate = compile();

  it('accepts a workspace with worktreePath, branch, createdByGan only', () => {
    // The three fields O2 section 2 calls out as legacy (F7's shipped
    // `recordWorkspace` writes them) are exactly what `additionalProperties:
    // false` permits — nothing more, nothing less.
    const candidate = {
      ...inFlightBase(),
      workspace: {
        worktreePath: '/abs/path/to/worktree',
        branch: 'gan/20260512T094233-7c1a',
        createdByGan: false,
      },
    };
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('progress-v1 schema accepts an empty recoveryHistory array', () => {
  const validate = compile();

  it('accepts recoveryHistory: []', () => {
    // A fresh, never-recovered run carries an empty array; the schema must
    // not require at least one entry (which would block every first-time run).
    const candidate = { ...inFlightBase(), recoveryHistory: [] };
    expect(validate(candidate)).toBe(true);
  });

  it('accepts a recoveryHistory entry with all three required fields', () => {
    // The minimal entry shape: recoveredAt + fromStatus + atSprint, each
    // typed per O2 section 2.
    const candidate = {
      ...inFlightBase(),
      recoveryHistory: [
        { recoveredAt: '2026-05-12T10:05:14.000Z', fromStatus: 'building', atSprint: 2 },
      ],
    };
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('progress-v1 schema couples terminal to terminalReason and terminalAt (cross-field invariant)', () => {
  // The writer contract: terminal:true requires the FULL terminal triple
  // (non-null terminalReason + non-null terminalAt); terminal:false requires
  // both to be null. The schema's if/then clause is the reconciliation gate's
  // teeth against a writer that wrote only part of a teardown — a half-terminal
  // record (e.g. terminal:true with null reason/time) is exactly the writer-vs-
  // schema drift class the gate exists to catch, so accepting one would
  // undermine the gate's purpose. The four negative cases below pin each
  // mismatched combination; the two positive cases pin the legal shapes.
  const validate = compile();

  it('accepts terminal:true with non-null terminalReason and non-null terminalAt (the full terminal triple)', () => {
    // Positive case: the canonical teardown shape the orchestrator writes on
    // graceful end (AC 1), max-attempts failure (AC 2), and user abort (AC 3).
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'complete',
      terminalAt: '2026-05-12T10:18:47Z',
    };
    const ok = validate(candidate);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts terminal:false with null terminalReason and null terminalAt (the in-flight shape)', () => {
    // Positive case: the in-flight tuple every run carries until teardown.
    // inFlightBase() already encodes this shape; the explicit assertion here
    // pins the if/false branch of the cross-field invariant.
    const candidate = {
      ...inFlightBase(),
      terminal: false,
      terminalReason: null,
      terminalAt: null,
    };
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects terminal:true with null terminalReason and non-null terminalAt (half-terminal: missing reason)', () => {
    // Negative case 1 of 4: writer set terminal and a timestamp but forgot the
    // discriminator code. The gate must reject — the spec's enumerated codes
    // are how downstream consumers branch on outcome.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: null,
      terminalAt: '2026-05-12T10:18:47Z',
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects terminal:true with non-null terminalReason and null terminalAt (half-terminal: missing time)', () => {
    // Negative case 2 of 4: writer set terminal and the reason code but forgot
    // the timestamp. The gate must reject — every AC 1/2/3 writer path records
    // the moment teardown happened, and recovery code keys off terminalAt.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'complete',
      terminalAt: null,
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects terminal:true with both terminalReason null and terminalAt null (half-terminal: missing both)', () => {
    // Negative case 3 of 4: pins the invariant that `terminal:true` requires
    // BOTH `terminalReason` and `terminalAt` to be non-null (and `terminal:false`
    // requires both to be null). Without the schema's if/then coupling this
    // half-terminal shape validates clean even though it contradicts the
    // writer contract — and the reconciliation gate exists precisely to catch
    // writer divergence, so a half-terminal record getting past the gate
    // defeats the gate's purpose.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: null,
      terminalAt: null,
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects terminal:false with non-null terminalReason and non-null terminalAt (in-flight with terminal triple)', () => {
    // Negative case 4 of 4: the inverse half-state — a run that claims to be
    // in-flight while carrying a teardown reason and timestamp. A writer that
    // cleared terminal but left the triple is just as broken as one that set
    // terminal without the triple.
    const candidate = {
      ...inFlightBase(),
      terminal: false,
      terminalReason: 'complete',
      terminalAt: '2026-05-12T10:18:47Z',
    };
    expect(validate(candidate)).toBe(false);
  });
});

describe('progress-v1 schema rejects unenumerated and malformed shapes', () => {
  const validate = compile();

  it('rejects an unknown top-level field — additionalProperties:false is operative', () => {
    // The load-bearing negative case: without `additionalProperties:false`
    // the strict schema is advisory rather than gating. The Ajv error must
    // name both the keyword and the offending property so a downstream
    // reader can surface a targeted fix.
    const candidate = { ...inFlightBase(), unknownKey: 1 };
    const ok = validate(candidate);
    expect(ok).toBe(false);
    const text = JSON.stringify(validate.errors);
    expect(text).toMatch(/additionalProperties/);
    expect(text).toMatch(/unknownKey/);
  });

  it('rejects an unknown terminalReason value', () => {
    // A typo'd or future-but-unrecognised reason must not silently validate;
    // a writer that produces an unknown value is by definition out of sync
    // with the schema, which is exactly what the reconciliation gate catches.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'made-up',
      terminalAt: '2026-05-12T10:18:47.512Z',
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects a terminalAt value of the wrong type (number)', () => {
    // terminalAt is anyOf{ null, ISO-8601 string } — a number is neither and
    // must fail. Tests the type-mismatch path on a nullable field.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'complete',
      terminalAt: 42,
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects a workspace object missing createdByGan', () => {
    // The required-list assertion: dropping the createdByGan field (which
    // --cleanup uses to classify teardown) must be a hard error.
    const base = inFlightBase();
    const { createdByGan: _drop, ...partialWorkspace } = base.workspace as Record<string, unknown>;
    void _drop;
    const candidate = { ...base, workspace: partialWorkspace };
    expect(validate(candidate)).toBe(false);
  });

  // Coverage discipline for this block: every contract-bearing keyword in
  // the schema (`pattern` on each $ref'd or inline regex, `enum` on each
  // closed set, `additionalProperties:false` on each nested closure, every
  // `anyOf` branch) is exercised by at least one negative case below. Keep
  // this property when extending the schema.

  // --- pattern: runId (schemas/progress-v1.json runId property; the
  // canonical regex lives at RUN_ID_PATTERN in
  // src/config-server/storage/run-store.ts — both are the same contract) ---
  it('rejects a runId that violates the pattern (free-form string)', () => {
    // Source of truth for the pattern: RUN_ID_PATTERN in
    // src/config-server/storage/run-store.ts. A value that does not match
    // cannot be reconstituted into a run directory path by any framework code.
    const candidate = { ...inFlightBase(), runId: 'not-a-run-id' };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects a runId that violates the pattern (uppercase hex)', () => {
    // The pattern's hex segment is `[0-9a-f]{4}` — uppercase hex is rejected.
    // Same source of truth as the previous case (RUN_ID_PATTERN in
    // src/config-server/storage/run-store.ts).
    const candidate = { ...inFlightBase(), runId: '20260512T094233-7C1A' };
    expect(validate(candidate)).toBe(false);
  });

  // --- pattern: isoDateTime (schemas/progress-v1.json definitions.isoDateTime
  // — the regex requires a trailing Z and forbids local-tz offsets) ---
  it('rejects a terminalAt string with a local-tz offset (the pattern forbids non-Z)', () => {
    // The isoDateTime pattern forbids local-timezone offsets — a trailing Z
    // is required by the schema's definitions.isoDateTime regex.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'complete',
      terminalAt: '2026-05-12T10:18:47+02:00',
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects a terminalAt string with a space rather than T (isoDateTime pattern)', () => {
    // The isoDateTime pattern requires a literal `T` between date and time —
    // a space is not accepted even with the trailing Z.
    const candidate = {
      ...inFlightBase(),
      terminal: true,
      terminalReason: 'complete',
      terminalAt: '2026-05-12 10:18:47Z',
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects a recoveryHistoryEntry recoveredAt that violates the isoDateTime pattern (missing Z)', () => {
    // The nested recoveryHistoryEntry.recoveredAt $refs isoDateTime — the
    // same trailing-Z requirement applies at the nested call site.
    const candidate = {
      ...inFlightBase(),
      recoveryHistory: [
        { recoveredAt: '2026-05-12T10:05:14', fromStatus: 'building', atSprint: 2 },
      ],
    };
    expect(validate(candidate)).toBe(false);
  });

  // --- additionalProperties:false on nested closures
  // (schemas/progress-v1.json — workspace, overlaysAtSnapshot,
  // recoveryHistoryEntry each declare the closure locally) ---
  it('rejects an unknown field inside `workspace` (nested additionalProperties:false closure)', () => {
    // The workspace object declares `additionalProperties:false`; an extra
    // sibling (e.g. a maintainer adds `oldBranch` without updating the
    // schema's properties list) must fail.
    const base = inFlightBase();
    const candidate = {
      ...base,
      workspace: { ...(base.workspace as object), oldBranch: 'x' },
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects an unknown tier inside `overlaysAtSnapshot` (nested additionalProperties:false closure)', () => {
    // overlaysAtSnapshot enumerates the legal tiers (user, project) and
    // declares `additionalProperties:false`; a third tier (e.g. `builtin`)
    // must fail at the nested closure.
    const base = inFlightBase();
    const candidate = {
      ...base,
      overlaysAtSnapshot: {
        ...(base.overlaysAtSnapshot as object),
        builtin: { loaded: false, path: null, hash: null },
      },
    };
    expect(validate(candidate)).toBe(false);
  });

  it('rejects an unknown field inside a `recoveryHistoryEntry` (nested additionalProperties:false closure)', () => {
    // recoveryHistoryEntry declares `additionalProperties:false`; a
    // well-formed entry that carries an extra field (e.g. `triggeredBy`)
    // must fail at the nested closure.
    const candidate = {
      ...inFlightBase(),
      recoveryHistory: [
        {
          recoveredAt: '2026-05-12T10:05:14Z',
          fromStatus: 'building',
          atSprint: 2,
          triggeredBy: 'user',
        },
      ],
    };
    expect(validate(candidate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live-writer assertions: prove that the shipped writers produce output that
// validates clean against the bundled `progressV1` Ajv validator. The
// hand-rolled fixture above pins schema shape; these tests close the loop
// by exercising the actual source writers — without this block the schema
// is internally consistent but no production caller's output is checked
// against it. The block resolves cluster C-2 (issue I-001).
// ---------------------------------------------------------------------------

const liveWriterTmpDirs: string[] = [];

function makeLiveWriterTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'progress-v1-live-'));
  liveWriterTmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of liveWriterTmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function liveRunContext(): RunContextForSeed {
  return {
    runId: '20260601T030830-1a2b',
    projectRoot: '/Users/example/projects/sample-app',
    runBranch: 'feature/sample',
    baseBranch: 'develop',
    startingBranch: 'develop',
    workspace: {
      worktreePath: '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
    },
    overlaysAtSnapshot: {
      user: { loaded: false, path: null, hash: null },
      project: { loaded: false, path: null, hash: null },
    },
  };
}

describe('live writers produce conforming output (cluster C-2)', () => {
  it('seedProgress produces a document that validates against progress-v1', () => {
    const dir = makeLiveWriterTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, liveRunContext());
    const onDisk = JSON.parse(readFileSync(progressPath, 'utf8'));
    const result = validateProgress(onDisk);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('seedProgress + recordWorkspace round-trip validates against progress-v1', () => {
    const dir = makeLiveWriterTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, liveRunContext());

    const resolved: ResolvedWorkspace = {
      worktreePath:
        '/Users/example/projects/sample-app/.gan-state/runs/20260601T030830-1a2b/worktree',
      branch: 'feature/sample',
      createdByGan: true,
      resolutionCase: '1c',
    };
    recordWorkspace(progressPath, resolved);
    const onDisk = JSON.parse(readFileSync(progressPath, 'utf8'));
    const result = validateProgress(onDisk);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('seedProgress + writeProgressFields(narrow update) round-trip validates against progress-v1', () => {
    const dir = makeLiveWriterTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, liveRunContext());
    // A typical narrow update from the renegotiation loop.
    writeProgressFields(progressPath, { status: 'negotiating' });
    const onDisk = JSON.parse(readFileSync(progressPath, 'utf8'));
    const result = validateProgress(onDisk);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('seedProgress + buildFailedEvaluationRejectedRecord + writeProgressFields persists a schema-conforming terminal record', () => {
    const dir = makeLiveWriterTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, liveRunContext());

    const built = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: [{ id: 'b-1' }],
    });
    expect(built.write).toBe(true);
    expect(built.record).toBeDefined();
    if (built.record !== undefined) {
      writeProgressFields(progressPath, { ...built.record });
    }
    const onDisk = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.terminal).toBe(true);
    expect(onDisk.terminalReason).toBe('failed-evaluation-rejected');
    expect(typeof onDisk.terminalAt).toBe('string');
    const result = validateProgress(onDisk);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('seedProgress + buildLoopHaltTerminalRecord + writeProgressFields persists a schema-conforming terminal record', () => {
    const dir = makeLiveWriterTmp();
    const progressPath = path.join(dir, 'progress.json');
    seedProgress(progressPath, liveRunContext());

    const record = buildLoopHaltTerminalRecord();
    writeProgressFields(progressPath, { ...record });
    const onDisk = JSON.parse(readFileSync(progressPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.terminal).toBe(true);
    expect(onDisk.terminalReason).toBe('failed-loop-detected');
    expect(typeof onDisk.terminalAt).toBe('string');
    const result = validateProgress(onDisk);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('the writer-supplied terminalAt matches the schema isoDateTime pattern', () => {
    // Pin the wire shape that satisfies the schema's cross-field invariant:
    // the writers stamp a trailing-Z UTC timestamp that the
    // definitions.isoDateTime pattern accepts.
    const failed = buildFailedEvaluationRejectedRecord({
      capFired: true,
      unresolvedBlockers: [{ id: 'b-1' }],
    });
    const loopHalt = buildLoopHaltTerminalRecord();
    const isoZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
    expect(failed.record?.terminalAt).toMatch(isoZ);
    expect(loopHalt.terminalAt).toMatch(isoZ);
  });
});
