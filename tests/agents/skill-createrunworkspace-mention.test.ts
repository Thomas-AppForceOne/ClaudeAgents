/**
 * SKILL.md createRunWorkspace-mention suite — reads the SHIPPED
 * skills/gan/SKILL.md verbatim and asserts the writing tool
 * `createRunWorkspace` is named ONLY in the regular invocation flow, never in
 * the inspection/recovery short-circuits or cleanup/recovery sections.
 *
 * The previous backstop for this invariant was a tautology over a local
 * `dispatchOrchestrator` helper in tests/config-server/tools/run-context.test.ts:
 * it asserted that a test-local function did what its body said, which can
 * never fail and never observed the markdown prose that actually drives the
 * orchestrator. This suite replaces that with a string-walk over the shipped
 * skill file (the actual SUT — the markdown contract the model executes),
 * modelled on tests/agents/skill-trace-wiring.test.ts. A future SKILL.md edit
 * that lifted `createRunWorkspace` into the cleanup or recovery flow would
 * fail these assertions on the next CI run.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');
const skill = readFileSync(skillPath, 'utf8');

describe('SKILL.md createRunWorkspace mention is confined to the regular invocation flow', () => {
  // Walk the prose: locate a `## <name>` heading and return everything from
  // that heading down to (but not including) the next `## ` heading. The
  // returned chunk is the body of exactly one named section, so the
  // section-by-section assertions below cannot leak across boundaries.
  function sectionBody(name: string): string {
    const startMarker = `## ${name}`;
    const start = skill.indexOf(startMarker);
    if (start < 0) throw new Error(`SKILL.md is missing section "${name}"`);
    const after = skill.indexOf('\n## ', start + startMarker.length);
    return skill.slice(start, after < 0 ? skill.length : after);
  }

  it('the "Inspection and recovery short-circuits" section does NOT name createRunWorkspace', () => {
    const body = sectionBody('Inspection and recovery short-circuits');
    expect(body).not.toContain('createRunWorkspace');
  });

  it('the "Cleanup and recovery" section does NOT name createRunWorkspace', () => {
    const body = sectionBody('Cleanup and recovery');
    expect(body).not.toContain('createRunWorkspace');
  });

  it('the "Regular invocation flow" section names createRunWorkspace exactly once', () => {
    const body = sectionBody('Regular invocation flow');
    const matches = body.match(/createRunWorkspace/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('the SKILL.md file as a whole names createRunWorkspace exactly once', () => {
    // Defence-in-depth against a future regression that adds a second mention
    // outside any of the three named sections (e.g. a new "Resumption" block).
    // If the term legitimately needs to appear elsewhere — e.g. as a parameter
    // doc in another section — update this assertion and document the new
    // home in the same diff.
    const matches = skill.match(/createRunWorkspace/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
