/**
 * `checkRoleCeiling` flat-shape contract.
 *
 * The boundary previously accepted two transport shapes — a flat call
 * (`{ role, attemptState, ceilings, evidence }`) and a nested call
 * (`{ role, input: { attemptState, ceilings, evidence } }`) — and silently
 * preferred the nested shape when both were present. This is the
 * silent-shadow hazard the C-2/I-005 fix retired by collapsing the boundary
 * to the flat shape (matching sibling safety tools `checkSprintBudget`,
 * `detectEditOscillation`, and `buildEvaluatorPlan`).
 *
 * This file pins the post-fix contract from three angles, so a regression
 * that reintroduces the nested alternative flunks here rather than at the
 * silent-data-loss surface:
 *
 *  - The shipped library function accepts the flat-shaped arguments
 *    verbatim and returns the canonical CeilingDecision (positive parity
 *    with the existing tool-vs-library byte-identical assertion in
 *    `tests/config-server/tools/safety-tools.test.ts`).
 *  - The catalog schema entry carries the four flat fields as required —
 *    no `input` key, no `additionalProperties` escape hatch — so a JSON-
 *    Schema validator at the wire boundary refutes the nested shape.
 *  - The dispatcher source carries no `args['input']` read on the
 *    `checkRoleCeiling` handler (static scan; the same shape the
 *    `safety-tools.test.ts` no-subprocess scan uses to police the source
 *    surface).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkRoleCeiling as libraryCheckRoleCeiling,
  DEFAULT_ATTEMPT_CEILINGS,
} from '../../src/safety/index.js';
import { checkRoleCeilingTool } from '../../src/config-server/tools/safety.js';
import type { RoleAttemptState } from '../../src/trace/reconcile.js';
import type { RoleCeilingEvidenceEntry } from '../../src/safety/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function attemptState(count: number): RoleAttemptState {
  return { attemptCount: count, highestAttemptNumber: count };
}

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

describe('checkRoleCeiling: flat wire shape (no nested `input` alternation)', () => {
  it('library accepts the flat-shape arguments and halts at ceiling', () => {
    const ceiling = DEFAULT_ATTEMPT_CEILINGS['gan-generator'];
    const input = {
      role: 'gan-generator',
      attemptState: attemptState(ceiling),
      evidence: evidenceFor(ceiling),
    };
    const decision = libraryCheckRoleCeiling(input);
    expect(decision.halt).toBe(true);
    expect(decision.fields?.reason).toBe('roleCeilingExceeded');
  });

  it('tool wrapper accepts the flat-shape arguments and is byte-identical to the library', () => {
    const ceiling = DEFAULT_ATTEMPT_CEILINGS['gan-generator'];
    const input = {
      role: 'gan-generator',
      attemptState: attemptState(ceiling),
      evidence: evidenceFor(ceiling),
    };
    expect(checkRoleCeilingTool(input)).toEqual(libraryCheckRoleCeiling(input));
  });

  it('catalog schema declares the four flat properties as required and lists no `input` key', () => {
    const schemaPath = path.resolve(repoRoot, 'schemas/api-tools-v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties: Record<
        string,
        { inputSchema: { properties: Record<string, unknown>; required: string[] } }
      >;
    };
    const entry = schema.properties['checkRoleCeiling'].inputSchema;
    const propNames = Object.keys(entry.properties).sort();
    expect(propNames).toEqual(['attemptState', 'ceilings', 'evidence', 'role']);
    expect(propNames).not.toContain('input');
    expect([...entry.required].sort()).toEqual(['attemptState', 'ceilings', 'evidence', 'role']);
  });

  it('dispatcher source carries no `args[\'input\']` read on the checkRoleCeiling handler', () => {
    // Locate the `checkRoleCeiling:` handler in src/config-server/index.ts and
    // scan its body for any `args['input']` / `args.input` access. The flat-
    // shape boundary reads attemptState/ceilings/evidence directly off `args`;
    // re-introducing a nested-shape branch would have to re-introduce this
    // token first, which this scan refuses to let pass silently.
    const indexFile = path.resolve(repoRoot, 'src/config-server/index.ts');
    const text = readFileSync(indexFile, 'utf8');
    const startIdx = text.indexOf('\n  checkRoleCeiling: {');
    expect(startIdx).toBeGreaterThan(-1);
    // The next dispatch entry begins with the same two-space indent + identifier.
    const afterStart = text.slice(startIdx + 1);
    const nextEntryMatch = afterStart.match(/\n  [a-zA-Z]+: \{/);
    const body = nextEntryMatch
      ? afterStart.slice(0, nextEntryMatch.index)
      : afterStart;
    expect(body).not.toMatch(/args\s*\[\s*['"]input['"]\s*\]/);
    expect(body).not.toMatch(/args\.input\b/);
  });
});
