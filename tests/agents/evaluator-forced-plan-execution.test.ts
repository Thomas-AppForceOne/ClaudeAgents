/**
 * Structural prompt assertions over `agents/gan-evaluator.md` for the
 * forced-plan-execution wiring.
 *
 * Purpose: the rewritten evaluator prompt must *bind* the LLM evaluator
 * mechanically to the plan the framework hands it, and must *force* it to
 * execute every command the plan lists rather than reasoning about what the
 * command would have produced. These are mechanical, byte-level concerns: a
 * later prose drift that silently re-introduces "delegate to evaluator-core"
 * (no call path), or that softens "execute" to "consider", would defeat the
 * entire forced-verification mechanism the sprint exists to ship. Asserting
 * the prompt body carries the exact bindings keeps prompt and behaviour
 * coupled.
 *
 * The three concerns covered, one describe block each:
 * 1. Mandatory `buildEvaluatorPlan` consumption — the tool name appears
 *    verbatim and is called out as MUST-call, and the prompt also forbids
 *    re-derivation.
 * 2. Bash-executed plan commands — the prompt states every plan command runs
 *    through the agent's `Bash` tool, that the captured exit code + a
 *    stdout/stderr snippet is the evidence, and that a *reasoned expectation*
 *    is explicitly **not** acceptable evidence for a command-backed criterion.
 * 3. `absenceSignal` warning path — a plan command marked absent surfaces
 *    `absenceMessage` and does **not** auto-fail; a flaky / non-deterministic
 *    / timing-out command is recorded but does not auto-fail on flakiness
 *    alone.
 *
 * Failure modes guarded: every assertion here is a byte-search over the
 * shipped prompt. The test does not run the prompt; it reads the file and
 * asserts the prose carries the binding. A future rewrite that removes one
 * of the bindings fails this test before the change reaches CI.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-evaluator.md');
const prompt = readFileSync(promptPath, 'utf8');

describe('evaluator_prompt_mandates_buildEvaluatorPlan_consumption', () => {
  it('names `buildEvaluatorPlan` verbatim — the tool the evaluator MUST call', () => {
    // The tool name is the mechanical binding. A drift away from the literal
    // string `buildEvaluatorPlan` (e.g. "the planner tool", "evaluator-core's
    // plan") breaks the mechanical-audit promise even if the prose stays
    // plausible, because the lint can no longer key on a known identifier.
    expect(prompt).toContain('buildEvaluatorPlan');
  });

  it('binds the evaluator with MUST-call language, not optional or polite-suggestion language', () => {
    // "MUST call" + the tool name in close proximity. The assertion is
    // case-sensitive on MUST because the prompt's elsewhere-uppercased
    // MUST/SHOULD vocabulary is the rule-binding signal — a lowercase
    // "must call" is intentionally weaker and would not satisfy this.
    expect(prompt).toMatch(/MUST call.{0,80}buildEvaluatorPlan/);
  });

  it('forbids re-deriving the plan (consume the plan as data, do not invent it)', () => {
    expect(prompt.toLowerCase()).toContain('do not re-derive');
    expect(prompt.toLowerCase()).toContain('consume');
  });

  it('removes the legacy "delegate every deterministic decision to evaluator-core" prose', () => {
    // The legacy prose pointed at a non-existent call path and is the exact
    // thing the rewrite replaces. A later regression that re-introduces it
    // would silently re-open the path that "verification is reasoned, not
    // run" warned about.
    expect(prompt).not.toContain('delegate every deterministic decision');
  });
});

describe('evaluator_prompt_mandates_bash_execution_of_plan_commands', () => {
  it('states every plan command is executed through the agent `Bash` tool', () => {
    // The literal token "Bash" is the agent-side tool name the evaluator's
    // frontmatter declares; the prompt must say so explicitly so the
    // forced-execution rule is unambiguous.
    expect(prompt).toMatch(/(through|via) the agent'?s `Bash` tool/i);
  });

  it('names the command categories the plan lists (test, lint, build, audit, secrets-scan, doc-lint)', () => {
    // Spec body §3 enumerates these; the prompt must list them in the forced-
    // execution section so an evaluator cannot omit one as "not a real
    // command" — they are all real plan commands and all run.
    expect(prompt).toMatch(/test.*lint.*build.*audit.*secrets.{0,5}scan.*doc.{0,5}lint/is);
  });

  it('mandates the captured exit code AND a stdout/stderr snippet as evidence', () => {
    expect(prompt.toLowerCase()).toContain('exit code');
    expect(prompt).toMatch(/stdout\/?stderr|stdout.{0,20}stderr/i);
  });

  it('explicitly states a reasoned expectation is NOT acceptable evidence for a command-backed criterion', () => {
    // This is the load-bearing assertion of feature 17: the
    // expectation-vs-execution distinction is the change. Drift here would
    // silently re-admit "I would expect this command to pass" as evidence.
    expect(prompt).toMatch(
      /reasoned expectation is (not|NOT) acceptable evidence.{0,80}command-backed criterion/i,
    );
  });

  it('runs under the framework PreToolUse confinement hook (not a free shell)', () => {
    expect(prompt).toContain('PreToolUse');
    expect(prompt.toLowerCase()).toContain('confinement');
  });
});

describe('evaluator_prompt_documents_absence_signal_warning_path', () => {
  it('a plan command whose `absenceSignal` fires follows the `absenceMessage` warning path', () => {
    // Tokens `absenceSignal` and `absenceMessage` are the schema names; they
    // must appear verbatim so the prose ties to the snapshot field.
    expect(prompt).toContain('absenceSignal');
    expect(prompt).toContain('absenceMessage');
  });

  it('states tool absence does NOT auto-fail the criterion on absence alone', () => {
    expect(prompt).toMatch(/do (\*\*)?not(\*\*)? auto-fail.{0,80}absence|absence (alone|signal).{0,80}does (\*\*)?not(\*\*)? auto-fail/i);
  });

  it('a flaky / non-deterministic / timing-out command is recorded as such, not auto-failed', () => {
    // The mirror of the absence path: flakiness is signal, not a sprint-
    // failing verdict by itself. Without this the forced-execution rule
    // would punish legitimate environment flake.
    expect(prompt).toMatch(/(flaky|non-deterministic|timing.?out|times out)/i);
    expect(prompt).toMatch(/(does (\*\*)?not(\*\*)? auto-fail|not.{0,30}auto-fail).{0,80}flak/i);
  });
});
