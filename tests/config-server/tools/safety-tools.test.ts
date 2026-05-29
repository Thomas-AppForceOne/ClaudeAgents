/**
 * Safety MCP tool tests — the central slice-3 acceptance file.
 *
 * Each named describe block pins one sprint-3 contract criterion and runs
 * independently, so a single regression flunks exactly the failing case rather
 * than the whole file. The structural shape (eight named describe blocks) is
 * itself a criterion: a partial scaffold silently degrades the contract.
 *
 * Sections:
 *  - tool-vs-library parity for the six new tools (criteria 9–12);
 *  - decision agreement on per-role ceiling at and below (criterion 13);
 *  - decision agreement on sprint budget at and below (criterion 14);
 *  - decision agreement on oscillation directRepeat after rejections (#15);
 *  - decision agreement on oscillation 3cycle A→B→A (#16);
 *  - decision agreement on oscillation NOT triggered without prior rejection
 *    (instructed revert, #17);
 *  - error-builder fidelity for the three error builders (#18, #19, #20)
 *    including the user-facing prose discipline (#21);
 *  - a deterministic static-scan asserting no child_process / exec / spawn
 *    token appears in the slice-3 sources (#29).
 *
 * Every fixture is constructed inline (no external fixture files); every
 * library call is a direct import to satisfy the dual-callable rule.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkRoleCeiling as libraryCheckRoleCeiling,
  checkSprintBudget as libraryCheckSprintBudget,
  createEditOscillationError as libraryCreateEditOscillationError,
  createLoopDetectedError as libraryCreateLoopDetectedError,
  createSprintBudgetError as libraryCreateSprintBudgetError,
  DEFAULT_ATTEMPT_CEILINGS,
  DEFAULT_SPRINT_BUDGET,
  detectEditOscillation as libraryDetectEditOscillation,
  OSCILLATION_ROLE,
  SPRINT_ROLE,
  type FingerprintHistory,
  type LoopDetectedFields,
  type RoleCeilingEvidenceEntry,
  type SprintBudgetEvidence,
} from '../../../src/safety/index.js';
import type { RoleAttemptState } from '../../../src/trace/reconcile.js';
import {
  checkRoleCeilingTool,
  checkSprintBudgetTool,
  createEditOscillationErrorTool,
  createLoopDetectedErrorTool,
  createSprintBudgetErrorTool,
  detectEditOscillationTool,
} from '../../../src/config-server/tools/safety.js';

// Reused fingerprint constants. The 64-char lowercase-hex shape is the
// fingerprint contract — the detector compares opaque strings of this exact
// shape, so the fixtures use synthetic but well-formed digests.
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const FP_C = 'c'.repeat(64);

// Helper: an attempt-state with the given count. highestAttemptNumber tracks
// the largest attemptNumber seen, which equals attemptCount when no events
// are missing — the normal case. Used inline by the per-role-ceiling cases.
function attemptState(count: number): RoleAttemptState {
  return { attemptCount: count, highestAttemptNumber: count };
}

// Helper: a role-ceiling evidence array of the requested length, with
// synthetic artefact paths/summaries. The detector does not consult the
// evidence content; it is forwarded onto the halt fields verbatim.
function evidenceFor(count: number): RoleCeilingEvidenceEntry[] {
  const out: RoleCeilingEvidenceEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      attemptNumber: i + 1,
      outputArtifactPath: `attempts/gan-generator-${i + 1}.json`,
      summary: `attempt ${i + 1} did not converge`,
    });
  }
  return out;
}

// ---------- 1. Tool-vs-library parity for the six new tools ----------

describe('Tool-vs-library parity for the six new tools', () => {
  it('checkRoleCeiling: tool and library return byte-identical CeilingDecision', () => {
    // A halting case — at-ceiling for the gan-generator role with the seed
    // table. Both code paths see the same input object so the same
    // single-implementation function produces the same return.
    const input = {
      role: 'gan-generator',
      attemptState: attemptState(DEFAULT_ATTEMPT_CEILINGS['gan-generator']),
      evidence: evidenceFor(DEFAULT_ATTEMPT_CEILINGS['gan-generator']),
    };
    const viaTool = checkRoleCeilingTool(input);
    const viaLib = libraryCheckRoleCeiling(input);
    expect(viaTool).toEqual(viaLib);
  });

  it('checkSprintBudget: tool and library return byte-identical CeilingDecision', () => {
    const input = {
      attemptStateByRole: {
        'gan-generator': attemptState(DEFAULT_SPRINT_BUDGET),
      },
    };
    const viaTool = checkSprintBudgetTool(input);
    const viaLib = libraryCheckSprintBudget(input);
    expect(viaTool).toEqual(viaLib);
  });

  it('detectEditOscillation: tool and library return byte-identical CeilingDecision', () => {
    const history: FingerprintHistory = [
      { fingerprint: FP_A, followedRejection: false },
      { fingerprint: FP_A, followedRejection: true },
      { fingerprint: FP_A, followedRejection: true },
    ];
    const viaTool = detectEditOscillationTool({ history });
    const viaLib = libraryDetectEditOscillation(history);
    expect(viaTool).toEqual(viaLib);
  });

  it('createLoopDetectedError: tool and library return byte-identical ConfigServerError', () => {
    const fields: LoopDetectedFields = {
      reason: 'roleCeilingExceeded',
      role: 'gan-generator',
      attempts: 3,
      ceiling: 3,
      evidence: evidenceFor(3),
    };
    const traceDir = '/tmp/sample-run/trace';
    const viaTool = createLoopDetectedErrorTool({ fields, traceDir });
    const viaLib = libraryCreateLoopDetectedError(fields, traceDir);
    expect(viaTool.toJSON()).toEqual(viaLib.toJSON());
    expect(viaTool.message).toBe(viaLib.message);
  });

  it('createSprintBudgetError: tool and library return byte-identical ConfigServerError', () => {
    const evidence: SprintBudgetEvidence = {
      totalAttempts: 12,
      perRoleCounts: {
        'gan-generator': 3,
        'gan-contract-proposer': 3,
        'gan-clarifier': 1,
        'gan-planner': 1,
        'gan-contract-reviewer': 2,
        'gan-evaluator': 2,
      },
    };
    const fields: LoopDetectedFields = {
      reason: 'sprintBudgetExceeded',
      role: SPRINT_ROLE,
      attempts: 12,
      ceiling: DEFAULT_SPRINT_BUDGET,
      // Same cross-discriminator seam the library uses.
      evidence: evidence as unknown as LoopDetectedFields['evidence'],
    };
    const traceDir = '/tmp/sample-run/trace';
    const viaTool = createSprintBudgetErrorTool({ fields, traceDir });
    const viaLib = libraryCreateSprintBudgetError(fields, traceDir);
    expect(viaTool.toJSON()).toEqual(viaLib.toJSON());
    expect(viaTool.message).toBe(viaLib.message);
  });

  it('createEditOscillationError: tool and library return byte-identical ConfigServerError', () => {
    const evidence = { fingerprintSequence: [FP_A, FP_B, FP_A], detectedPattern: '3cycle' };
    const fields: LoopDetectedFields = {
      reason: 'editOscillation',
      role: OSCILLATION_ROLE,
      attempts: 3,
      ceiling: 3,
      evidence: evidence as unknown as LoopDetectedFields['evidence'],
    };
    const traceDir = '/tmp/sample-run/trace';
    const viaTool = createEditOscillationErrorTool({ fields, traceDir });
    const viaLib = libraryCreateEditOscillationError(fields, traceDir);
    expect(viaTool.toJSON()).toEqual(viaLib.toJSON());
    expect(viaTool.message).toBe(viaLib.message);
  });
});

// ---------- 2. Decision agreement on per-role ceiling (at and below) ----------

describe('Decision agreement on per-role ceiling (at and below ceiling)', () => {
  // Both the at-ceiling positive and the below-ceiling negative cases must
  // hold simultaneously — they pin the `>=` boundary (regression to `>` would
  // flip the at-ceiling case from halt to no-halt).
  it('at-ceiling halts and matches the library byte-for-byte', () => {
    const ceiling = DEFAULT_ATTEMPT_CEILINGS['gan-generator']; // 3
    const input = {
      role: 'gan-generator',
      attemptState: attemptState(ceiling),
      evidence: evidenceFor(ceiling),
    };
    const viaTool = checkRoleCeilingTool(input);
    const viaLib = libraryCheckRoleCeiling(input);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(true);
    expect(viaTool.fields?.reason).toBe('roleCeilingExceeded');
    expect(viaTool.fields?.role).toBe('gan-generator');
    expect(viaTool.fields?.attempts).toBe(3);
    expect(viaTool.fields?.ceiling).toBe(3);
  });

  it('below-ceiling does not halt and matches the library byte-for-byte', () => {
    const ceiling = DEFAULT_ATTEMPT_CEILINGS['gan-generator']; // 3
    const input = {
      role: 'gan-generator',
      attemptState: attemptState(ceiling - 1),
      evidence: evidenceFor(ceiling - 1),
    };
    const viaTool = checkRoleCeilingTool(input);
    const viaLib = libraryCheckRoleCeiling(input);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(false);
    expect(viaTool.fields).toBeUndefined();
  });
});

// ---------- 3. Decision agreement on sprint budget (at and below) ----------

describe('Decision agreement on sprint budget (at and below budget)', () => {
  // At-budget halt and below-budget no-halt pin the `>=` boundary on the
  // aggregate sum across roles — regression to `>` would flip the at-budget
  // case silently.
  it('at-budget halts and matches the library byte-for-byte', () => {
    const stateMap: Record<string, RoleAttemptState> = {
      'gan-contract-proposer': attemptState(3),
      'gan-generator': attemptState(3),
      'gan-clarifier': attemptState(1),
      'gan-planner': attemptState(1),
      'gan-contract-reviewer': attemptState(2),
      'gan-evaluator': attemptState(2),
    };
    const input = { attemptStateByRole: stateMap };
    const viaTool = checkSprintBudgetTool(input);
    const viaLib = libraryCheckSprintBudget(input);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(true);
    expect(viaTool.fields?.reason).toBe('sprintBudgetExceeded');
    expect(viaTool.fields?.role).toBe(SPRINT_ROLE);
    expect(viaTool.fields?.attempts).toBe(DEFAULT_SPRINT_BUDGET); // 12
    expect(viaTool.fields?.ceiling).toBe(DEFAULT_SPRINT_BUDGET);
  });

  it('below-budget does not halt and matches the library byte-for-byte', () => {
    const stateMap: Record<string, RoleAttemptState> = {
      'gan-contract-proposer': attemptState(3),
      'gan-generator': attemptState(2),
      'gan-clarifier': attemptState(1),
      'gan-planner': attemptState(1),
      'gan-contract-reviewer': attemptState(2),
      'gan-evaluator': attemptState(2),
    };
    const input = { attemptStateByRole: stateMap };
    const viaTool = checkSprintBudgetTool(input);
    const viaLib = libraryCheckSprintBudget(input);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(false);
    expect(viaTool.fields).toBeUndefined();
  });
});

// ---------- 4. Decision agreement on oscillation directRepeat ----------

describe('Decision agreement on oscillation directRepeat after rejections', () => {
  it('three identical fingerprints with rejection-following on the repeats halts via directRepeat', () => {
    // Boundary: the halt fires on the THIRD occurrence (the second repeat),
    // not on the first A→A repeat — a single repeat could be an instructed
    // revert. The fixture pins that boundary by being three-deep with both
    // the second and third attempts post-rejection.
    const history: FingerprintHistory = [
      { fingerprint: FP_A, followedRejection: false },
      { fingerprint: FP_A, followedRejection: true },
      { fingerprint: FP_A, followedRejection: true },
    ];
    const viaTool = detectEditOscillationTool({ history });
    const viaLib = libraryDetectEditOscillation(history);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(true);
    expect(viaTool.fields?.reason).toBe('editOscillation');
    expect(viaTool.fields?.role).toBe(OSCILLATION_ROLE);
    const evidence = viaTool.fields?.evidence as unknown as {
      detectedPattern: string;
      fingerprintSequence: string[];
    };
    expect(evidence.detectedPattern).toBe('directRepeat');
  });
});

// ---------- 5. Decision agreement on oscillation 3cycle ----------

describe('Decision agreement on oscillation 3cycle (A→B→A)', () => {
  it('A→B→A with rejection-following on the closing A halts via 3cycle', () => {
    // The 3cycle trigger compares only N against N−2 (a fixed two-step
    // lookback). The fixture pins that comparison shape: no two adjacent
    // attempts match, but attempt 3 matches attempt 1.
    const history: FingerprintHistory = [
      { fingerprint: FP_A, followedRejection: false },
      { fingerprint: FP_B, followedRejection: true },
      { fingerprint: FP_A, followedRejection: true },
    ];
    const viaTool = detectEditOscillationTool({ history });
    const viaLib = libraryDetectEditOscillation(history);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(true);
    expect(viaTool.fields?.reason).toBe('editOscillation');
    expect(viaTool.fields?.role).toBe(OSCILLATION_ROLE);
    const evidence = viaTool.fields?.evidence as unknown as {
      detectedPattern: string;
      fingerprintSequence: string[];
    };
    expect(evidence.detectedPattern).toBe('3cycle');
    expect(evidence.fingerprintSequence).toEqual([FP_A, FP_B, FP_A]);
  });
});

// ---------- 6. Decision agreement on instructed revert (post-rejection guard) ----------

describe('Decision agreement on oscillation NOT triggered without prior rejection (instructed revert)', () => {
  it('same fingerprint repeats WITHOUT prior rejection does not halt and matches the library', () => {
    // The post-rejection guard suppresses the halt when the repeating attempt
    // did not follow a rejection: an instructed revert is not oscillation.
    // The fixture pins that suppression — two identical fingerprints with
    // followedRejection=false on the second attempt yields no halt, even
    // though the fingerprints match.
    const history: FingerprintHistory = [
      { fingerprint: FP_A, followedRejection: false },
      { fingerprint: FP_A, followedRejection: false },
    ];
    const viaTool = detectEditOscillationTool({ history });
    const viaLib = libraryDetectEditOscillation(history);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(false);
    expect(viaTool.fields).toBeUndefined();
  });

  it('three identical fingerprints but with no rejection on the third also does not halt', () => {
    // A second negative-direction case: even the third occurrence does not
    // halt when the third attempt itself did not follow a rejection. Pins
    // that the guard applies per-attempt, not per-history.
    const history: FingerprintHistory = [
      { fingerprint: FP_C, followedRejection: false },
      { fingerprint: FP_C, followedRejection: true },
      { fingerprint: FP_C, followedRejection: false },
    ];
    const viaTool = detectEditOscillationTool({ history });
    const viaLib = libraryDetectEditOscillation(history);
    expect(viaTool).toEqual(viaLib);
    expect(viaTool.halt).toBe(false);
  });
});

// ---------- 7. Error-builder fidelity (criteria 18, 19, 20, 21) ----------

describe('Error builder fidelity for the three error builders', () => {
  it('createLoopDetectedError surfaces code, reason, role, attempts, ceiling, evidence; prose names role/count/ceiling, points at trace dir, mentions --recover', () => {
    const evidence = evidenceFor(3);
    const fields: LoopDetectedFields = {
      reason: 'roleCeilingExceeded',
      role: 'gan-generator',
      attempts: 3,
      ceiling: 3,
      evidence,
    };
    const traceDir = '/tmp/sample-run/trace';
    const err = createLoopDetectedErrorTool({ fields, traceDir });
    const json = err.toJSON();
    expect(json.code).toBe('LoopDetected');
    expect(json['reason']).toBe('roleCeilingExceeded');
    expect(json['role']).toBe('gan-generator');
    expect(json['attempts']).toBe(3);
    expect(json['ceiling']).toBe(3);
    expect(json['evidence']).toEqual(evidence);
    // Prose discipline.
    expect(err.message).toContain('gan-generator');
    expect(err.message).toContain('3');
    expect(err.message).toContain(traceDir);
    expect(err.message).toContain('--recover');
    expect(err.message).toContain('ClaudeAgents');
  });

  it('createSprintBudgetError surfaces code, reason, role, totalAttempts, perRoleCounts; prose names total/budget, points at trace dir, mentions --recover', () => {
    const evidence: SprintBudgetEvidence = {
      totalAttempts: 12,
      perRoleCounts: {
        'gan-generator': 3,
        'gan-contract-proposer': 3,
        'gan-clarifier': 1,
        'gan-planner': 1,
        'gan-contract-reviewer': 2,
        'gan-evaluator': 2,
      },
    };
    const fields: LoopDetectedFields = {
      reason: 'sprintBudgetExceeded',
      role: SPRINT_ROLE,
      attempts: 12,
      ceiling: DEFAULT_SPRINT_BUDGET,
      evidence: evidence as unknown as LoopDetectedFields['evidence'],
    };
    const traceDir = '/tmp/sample-run/trace';
    const err = createSprintBudgetErrorTool({ fields, traceDir });
    const json = err.toJSON();
    expect(json.code).toBe('LoopDetected');
    expect(json['reason']).toBe('sprintBudgetExceeded');
    expect(json['role']).toBe(SPRINT_ROLE);
    expect(json['role']).toBe('sprint');
    expect(json['attempts']).toBe(12);
    expect(json['ceiling']).toBe(DEFAULT_SPRINT_BUDGET);
    // Evidence rides through the shared field unchanged.
    const carriedEvidence = json['evidence'] as unknown as SprintBudgetEvidence;
    expect(carriedEvidence.totalAttempts).toBe(12);
    expect(carriedEvidence.perRoleCounts['gan-generator']).toBe(3);
    // Prose discipline.
    expect(err.message).toContain('12');
    expect(err.message).toContain(traceDir);
    expect(err.message).toContain('--recover');
    expect(err.message).toContain('ClaudeAgents');
  });

  it('createEditOscillationError surfaces code, reason, role, attempts, evidence (pattern + sequence); prose names pattern, points at trace dir, mentions --recover', () => {
    const evidence = { fingerprintSequence: [FP_A, FP_B, FP_A], detectedPattern: '3cycle' };
    const fields: LoopDetectedFields = {
      reason: 'editOscillation',
      role: OSCILLATION_ROLE,
      attempts: 3,
      ceiling: 3,
      evidence: evidence as unknown as LoopDetectedFields['evidence'],
    };
    const traceDir = '/tmp/sample-run/trace';
    const err = createEditOscillationErrorTool({ fields, traceDir });
    const json = err.toJSON();
    expect(json.code).toBe('LoopDetected');
    expect(json['reason']).toBe('editOscillation');
    expect(json['role']).toBe(OSCILLATION_ROLE);
    expect(json['role']).toBe('gan-generator');
    expect(json['attempts']).toBe(3);
    const carriedEvidence = json['evidence'] as unknown as {
      fingerprintSequence: string[];
      detectedPattern: string;
    };
    expect(carriedEvidence.detectedPattern).toBe('3cycle');
    expect(carriedEvidence.fingerprintSequence).toEqual([FP_A, FP_B, FP_A]);
    // Prose discipline: the message names the alternation pattern (3cycle
    // renders as "alternated between two interpretations" per the shipped
    // renderer) rather than asserting the discriminator label verbatim — the
    // user-facing prose is for humans, not machine parsing.
    expect(err.message).toContain('alternated');
    expect(err.message).toContain(traceDir);
    expect(err.message).toContain('--recover');
    expect(err.message).toContain('ClaudeAgents');
  });

  it('every builder honours the user-facing error-text discipline: ClaudeAgents idiom, no runtime-specific names, no maintainer-only script names', () => {
    // The same three messages, scanned for the forbidden tokens the
    // error-text discipline rejects.
    const traceDir = '/tmp/sample-run/trace';
    const a = createLoopDetectedErrorTool({
      fields: {
        reason: 'roleCeilingExceeded',
        role: 'gan-generator',
        attempts: 3,
        ceiling: 3,
        evidence: evidenceFor(3),
      },
      traceDir,
    });
    const b = createSprintBudgetErrorTool({
      fields: {
        reason: 'sprintBudgetExceeded',
        role: SPRINT_ROLE,
        attempts: 12,
        ceiling: DEFAULT_SPRINT_BUDGET,
        evidence: {
          totalAttempts: 12,
          perRoleCounts: { 'gan-generator': 3 },
        } as unknown as LoopDetectedFields['evidence'],
      },
      traceDir,
    });
    const c = createEditOscillationErrorTool({
      fields: {
        reason: 'editOscillation',
        role: OSCILLATION_ROLE,
        attempts: 3,
        ceiling: 3,
        evidence: {
          fingerprintSequence: [FP_A, FP_A, FP_A],
          detectedPattern: 'directRepeat',
        } as unknown as LoopDetectedFields['evidence'],
      },
      traceDir,
    });
    for (const msg of [a.message, b.message, c.message]) {
      // Idiom present.
      expect(msg).toContain('ClaudeAgents');
      // No runtime-name leaks.
      expect(msg).not.toMatch(/Node\.?js/i);
      expect(msg).not.toMatch(/\bnpm package\b/i);
      expect(msg).not.toMatch(/\bMCP server\b/i);
      // Shell remediation is documented (the actionable instruction).
      expect(msg).toContain('--recover');
    }
  });
});

// ---------- 8. Static-scan no subprocess token in slice-3 sources ----------

describe('Static-scan: no child_process / exec / spawn token in slice-3 sources', () => {
  it('the new slice-3 source files carry no exec/spawn/child_process token', () => {
    // The slice-3 sources: the new tools module plus the index.ts additions.
    // We scan index.ts in full as well, even though it pre-existed slice 3,
    // because the dispatch wiring is the surface this sprint touched and the
    // criterion's verifyCmd asks for both files. A pre-existing token would
    // surface here as a (slice-3) false positive, but the index.ts file does
    // not import child_process; both scans pass cleanly.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sources = ['src/config-server/tools/safety.ts', 'src/config-server/index.ts'].map((p) =>
      path.resolve(here, '..', '..', '..', p),
    );

    for (const file of sources) {
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');
      // No import statement from child_process (any of the four forms).
      expect(text).not.toMatch(/from\s+['"]child_process['"]/);
      expect(text).not.toMatch(/from\s+['"]node:child_process['"]/);
      expect(text).not.toMatch(/require\(\s*['"]child_process['"]\s*\)/);
      expect(text).not.toMatch(/require\(\s*['"]node:child_process['"]\s*\)/);
      // No subprocess token appears in the source bytes.
      expect(text).not.toMatch(/\bexec\(/);
      expect(text).not.toMatch(/\bexecSync\(/);
      expect(text).not.toMatch(/\bspawn\(/);
      expect(text).not.toMatch(/\bspawnSync\(/);
    }
  });
});
