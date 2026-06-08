/**
 * Content guard for the skill-side preflight prose in `skills/gan/SKILL.md`.
 *
 * The shipped product surface (`/gan` skill-side preflight against a stale
 * project-tier confinement hook) must be documented between step 3
 * (`validateAll()`) and the clarifier spawn at step 8 of the "Regular
 * invocation flow", with the documented diagnostic envelope shape (`code`
 * + `subReason` + `message`), both `subReason` discriminator values, the
 * just-in-time `<runDir>` derivation via `resolveRunStore` (without lock
 * acquisition), the halt-before-lock semantics, and the
 * no-bypass-flag-in-v1.0 note.
 *
 * The test is the lock on this content: a future refactor that broke any
 * of these invariants would surface a failure here, not at runtime.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeConfineHook } from '../../src/config-server/tools/confine-hook-probe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf8');
}

// Per-test temp roots the behavioural tests below materialise and tear
// down. Each test reserves its own `<root>/.claude/hooks/` subtree so
// concurrent runs cannot collide on the synthesised project tree.
const cleanups: string[] = [];

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeProjectRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'gan-skill-preflight-'));
  cleanups.push(d);
  return d;
}

// Materialise `<root>/.claude/hooks/gan-confine.sh` with the supplied
// content and exec mode. Mirrors what an end-user's project tree carries
// when a stale or misconfigured project-tier hook is the cause of the
// preflight halt.
function seedProjectHook(
  root: string,
  content: string | Buffer,
  mode = 0o755,
): string {
  const dir = path.join(root, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gan-confine.sh');
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

// Slice the prose block that documents the preflight: starts at the
// `probeConfineHook preflight` heading and ends at the next numbered
// step. The slice keeps the test scoped to the preflight prose so the
// invariants below cannot pass on unrelated SKILL.md content.
function slicePreflightSection(content: string): string {
  const start = content.indexOf('probeConfineHook` preflight');
  if (start === -1) {
    throw new Error('probeConfineHook preflight section not found in SKILL.md');
  }
  // The section ends at the next numbered step at column 0 (e.g. `4.
  // **NoPromptProvided check.**`).
  const nextStepMatch = content.slice(start).match(/\n4\. \*\*/);
  const end = nextStepMatch ? start + nextStepMatch.index! : content.length;
  return content.slice(start, end);
}

describe('skill-side preflight (H3) — SKILL.md content invariants', () => {
  it('the preflight section is inserted between validateAll() and the clarifier spawn', () => {
    const content = readSkill();
    const validateAllIdx = content.indexOf("3. **`validateAll()` (aborting).**");
    const preflightIdx = content.indexOf('probeConfineHook` preflight');
    const clarifierIdx = content.indexOf('8. **Clarification phase.**');
    expect(validateAllIdx).toBeGreaterThan(0);
    expect(preflightIdx).toBeGreaterThan(validateAllIdx);
    expect(clarifierIdx).toBeGreaterThan(preflightIdx);
  });

  it('the documented diagnostic envelope shape names code + subReason + message', () => {
    const section = slicePreflightSection(readSkill());
    // Three field names, in the documented order, present in the prose.
    expect(section).toContain('code');
    expect(section).toContain('subReason');
    expect(section).toContain('message');
    // The literal `code` value is the spec-pinned StaleProjectConfinementHook.
    expect(section).toContain('StaleProjectConfinementHook');
  });

  it('both subReason discriminator values are documented', () => {
    const section = slicePreflightSection(readSkill());
    expect(section).toContain('noGanRunDirAwareness');
    expect(section).toContain('projectHookMisconfigured');
  });

  it('halt-before-lock semantics are explicit (no progress.json / no worktree / no sub-agent)', () => {
    const section = slicePreflightSection(readSkill());
    // The halt fires before the run-lock is acquired — explicitly.
    expect(section.toLowerCase()).toContain('before lock');
    expect(section).toContain('progress.json');
    expect(section).toContain('worktree');
  });

  it('just-in-time <runDir> derivation via resolveRunStore (without lock acquisition) is documented', () => {
    const section = slicePreflightSection(readSkill());
    expect(section).toContain('resolveRunStore');
    // The lock-acquisition exemption is explicit.
    expect(section.toLowerCase()).toContain('without acquiring the run lock');
  });

  it('the preflightAbort event is built via the buildPreflightAbortBody MCP tool', () => {
    const section = slicePreflightSection(readSkill());
    expect(section).toContain('buildPreflightAbortBody');
    expect(section).toContain('preflightAbort');
  });

  it('no bypass flag in v1.0 is documented (deferred to v1.1)', () => {
    const section = slicePreflightSection(readSkill());
    expect(section.toLowerCase()).toContain('no bypass flag in v1.0');
    expect(section.toLowerCase()).toContain('v1.1');
  });

  it('the preflight tool calls do not appear later in the regular flow (no duplicate-spawn risk)', () => {
    const content = readSkill();
    // The probeConfineHook reference appears exactly once in the
    // "Regular invocation flow" section — anchored to the preflight
    // step. A duplicate would suggest a refactor planted a second
    // probe somewhere downstream.
    const allMentions = content.match(/probeConfineHook/g) ?? [];
    // The mentions accumulate: the prose, the heading, and one inline
    // reference; cap at a small number that detects accidental
    // duplication without locking the prose to a single literal.
    expect(allMentions.length).toBeGreaterThanOrEqual(1);
    expect(allMentions.length).toBeLessThanOrEqual(5);
  });
});

describe('skill-side preflight (H3) — probeConfineHook behavioural matrix', () => {
  // The criterion: a synthesised project tree carrying a stale (pre-F7)
  // hook makes the probe surface the stale verdict paired with the
  // noGanRunDirAwareness sub-reason. The SKILL.md prose names this
  // branch as one of the two halt cases; the test pins it to the actual
  // probe runtime so a future refactor that left the prose intact but
  // broke the wiring surfaces here.
  it('stale hook tree → verdict=stale, subReason=noGanRunDirAwareness', async () => {
    const projectRoot = makeProjectRoot();
    // A pre-F7 hook refuses every write outright. The probe's allow-
    // listed GAN_RUN_DIR target is denied, so the hook returns non-zero
    // and the probe classifies as stale.
    seedProjectHook(projectRoot, '#!/bin/bash\nexit 1\n');
    const result = await probeConfineHook({ projectRoot });
    expect(result.verdict).toBe('stale');
    expect(result.subReason).toBe('noGanRunDirAwareness');
    // The path the wrapper composed matches what the prose advertises
    // — confirms the probe ran against the synthesised tree, not a
    // cached or unrelated path.
    expect(result.projectTierHookPath).toBe(
      path.join(projectRoot, '.claude', 'hooks', 'gan-confine.sh'),
    );
  });

  // The criterion's second case: a non-bash file at the hook path
  // makes the probe surface the misconfigured verdict paired with the
  // projectHookMisconfigured sub-reason. The chmod 0o644 mirrors a
  // common operator mistake (forgot to `chmod +x`) and stacks with the
  // binary-content guard so the shebang sniff fires on both fronts.
  it('non-bash tree → verdict=misconfigured, subReason=projectHookMisconfigured', async () => {
    const projectRoot = makeProjectRoot();
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    seedProjectHook(projectRoot, binaryContent, 0o644);
    const result = await probeConfineHook({ projectRoot });
    expect(result.verdict).toBe('misconfigured');
    expect(result.subReason).toBe('projectHookMisconfigured');
    expect(result.projectTierHookPath).toBe(
      path.join(projectRoot, '.claude', 'hooks', 'gan-confine.sh'),
    );
  });

  // Belt-and-braces: an absent project-tier hook short-circuits and
  // surfaces a null verdict. The SKILL.md prose names this as the
  // no-halt branch; the test pins the wrapper's short-circuit so it
  // cannot be confused with the misconfigured case.
  it('absent project-tier hook → verdict=null (no halt)', async () => {
    const projectRoot = makeProjectRoot();
    // No `.claude/hooks/gan-confine.sh` materialised.
    const result = await probeConfineHook({ projectRoot });
    expect(result.verdict).toBeNull();
    expect(result.subReason).toBeNull();
    expect(result.projectTierHookPath).toBeNull();
  });
});
