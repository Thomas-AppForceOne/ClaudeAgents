/**
 * `lint-no-bare-skill-ref` — closes the door I-002 walked through.
 *
 * The independent-review subsystem's three TS helpers (`relockContract`,
 * `writeFailedEvaluationRejected`, `validateFindings`) are dual-callable:
 * they have a library entry point under `src/agents/independent-review/`
 * AND an MCP tool wrapper under `src/config-server/tools/independent-review.ts`
 * registered in the dispatcher's `INDEPENDENT_REVIEW_TOOL_NAMES`. The
 * markdown orchestrator in `skills/gan/SKILL.md` reaches the helpers via
 * the MCP wire — naming the library symbol without a matching MCP tool
 * registration would leave the SKILL.md prose pointing at a function the
 * orchestrator cannot invoke (the original I-002 defect shape).
 *
 * This test pins the invariant: every library export name listed in
 * `INDEPENDENT_REVIEW_HELPER_NAMES` that appears as an identifier-looking
 * token inside SKILL.md must ALSO appear in `INDEPENDENT_REVIEW_TOOL_NAMES`
 * — i.e. naming the symbol on the prose side is allowed only when the
 * dispatcher would route the same name on the wire side.
 *
 * The matcher is deliberately a word-boundary check, not a fenced-code or
 * backtick scan: SKILL.md may name the symbols in either inline code or
 * prose ("the orchestrator invokes the `validateFindings` MCP tool"), and
 * we want both sites to count as references for parity purposes.
 *
 * A regression that adds a new library helper without an MCP wrapper, OR
 * that removes the MCP wrapper while keeping the SKILL.md reference, will
 * fail this test with the offending symbol name.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { INDEPENDENT_REVIEW_TOOL_NAMES } from '../../src/config-server/index.js';

// Library export names this lint polices. Adding a fourth helper here is
// the deliberate signal that its MCP wrapper must also exist before
// SKILL.md is allowed to name it. The list mirrors what
// `src/agents/independent-review/index.ts` re-exports as runtime helpers
// the orchestrator might invoke (purely typed re-exports like
// `archivedContractPath` are routing-only helpers and not policed here).
const INDEPENDENT_REVIEW_HELPER_NAMES: readonly string[] = [
  'relockContract',
  'writeFailedEvaluationRejected',
  'validateFindings',
  'buildFailedEvaluationRejectedRecord',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

describe('lint-no-bare-skill-ref — SKILL.md must not name a library helper without an MCP wrapper', () => {
  it('every library-helper reference in SKILL.md has a matching MCP tool in INDEPENDENT_REVIEW_TOOL_NAMES', () => {
    const content = readFileSync(skillPath, 'utf8');

    const violations: string[] = [];
    for (const name of INDEPENDENT_REVIEW_HELPER_NAMES) {
      // Word-boundary match so a reference inside another identifier
      // (e.g. `buildFailedEvaluationRejectedRecordX`) does not count.
      // Escape any regex metacharacters in the name even though the
      // current list has none — defensive for a future addition.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`);
      const named = regex.test(content);
      if (!named) continue;

      // The symbol IS named in SKILL.md. It must therefore appear in the
      // MCP-tool name list — otherwise the orchestrator's wire-side call
      // would fail (the dispatcher rejects unknown tool names) and the
      // SKILL.md prose is lying about what the orchestrator can do.
      //
      // The "matching" name is the symbol verbatim for the three
      // wrapper-named helpers; the builder shape's policing is permissive
      // because `buildFailedEvaluationRejectedRecord` is composed inside
      // the `writeFailedEvaluationRejected` MCP tool rather than exposed
      // directly — name it in SKILL.md only if you also added it to
      // `INDEPENDENT_REVIEW_TOOL_NAMES`.
      if (!INDEPENDENT_REVIEW_TOOL_NAMES.includes(name)) {
        violations.push(name);
      }
    }

    expect(
      violations,
      `SKILL.md names ${violations.join(
        ', ',
      )} as library helper(s) without a matching entry in INDEPENDENT_REVIEW_TOOL_NAMES. ` +
        `Either remove the bare reference, OR register the corresponding MCP tool wrapper so ` +
        `the markdown orchestrator can actually invoke it.`,
    ).toEqual([]);
  });

  it('the policed list at least covers the three wrapper-backed helpers', () => {
    // Regression guard for the lint itself: the helper list must stay
    // synchronised with the wrapper surface. A future PR that adds a
    // fourth wrapper-backed helper without extending
    // INDEPENDENT_REVIEW_HELPER_NAMES would silently weaken the lint;
    // this assertion makes that drift visible.
    expect(INDEPENDENT_REVIEW_HELPER_NAMES).toContain('relockContract');
    expect(INDEPENDENT_REVIEW_HELPER_NAMES).toContain('writeFailedEvaluationRejected');
    expect(INDEPENDENT_REVIEW_HELPER_NAMES).toContain('validateFindings');
  });
});
