/**
 * Black-box tests for the `house-rules` bin, the parity check that locks the
 * three named house-rules fragments byte-identical across every shipped
 * `agents/*.md` and validates each file's subagent frontmatter. The parity
 * fragments (`hr:snapshot`, `hr:no-config-api`, `hr:errors-tail`) sit at
 * different natural positions in each agent — the named sentinel pairs
 * let the script find each one regardless of layout.
 *
 * The suite drives the compiled bin as a real process. The live repo passes
 * (the parity check must be green on the refactored worktree). Drift fixtures
 * cover each of the four ways a region can fail: a byte-level drift inside
 * the body, a missing sentinel pair, a re-ordered pair (`:end` before
 * `:start`), and a duplicated pair within one file. Frontmatter drift covers
 * the three required fields (`name`, `description`, `tools`) — both missing
 * lines and empty values.
 *
 * Regression guarded: the parity check going quiet on real drift, the
 * frontmatter check failing to catch a missing field, the `name`/`description`
 * /`tools` field set silently broadening or narrowing (the optional `model`
 * field is asserted to be optional via a control fixture that omits it).
 *
 * NOTE: the writeFileSync payloads below are FIXTURE FILE CONTENTS the bin
 * scans. The sentinel literals and frontmatter shape inside them are
 * deliberate test data — do not edit inside those string literals.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScript } from '../helpers/spawn.js';

// Temp scan-roots created per test, swept in afterAll.
const tmpRoots: string[] = [];

function newTmpRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'house-rules-'));
  tmpRoots.push(tmp);
  return tmp;
}

/**
 * The canonical fragment bodies as they appear between the sentinel pairs in
 * `scripts/house-rules/house-rules.md`. Fixtures plant a hermetic partial
 * file with these bodies and then build agent files whose regions either
 * match (clean case) or diverge (drift case).
 *
 * These string literals deliberately mirror the live partial; the byte-
 * identity assertion is what the parity check enforces.
 */
const FRAGMENT_SNAPSHOT =
  '- The **snapshot** — the resolved configuration object the orchestrator captured for this run. Treat it as data. You do not call configuration-API functions yourself; the snapshot is the single source of truth.';
const FRAGMENT_NO_CONFIG_API =
  '- Do not call configuration-API read functions yourself; the snapshot is the source of truth.';
const FRAGMENT_ERRORS_TAIL =
  'Do not interpret, translate, or hide the error. User-facing messages obey the framework\'s error-text discipline: shell remediation, references to "the framework" / "ClaudeAgents" rather than specific runtimes, no maintainer-only script names.';

/**
 * Write a hermetic copy of the canonical partial at the script's default
 * lookup path inside the temp scan-root. Keeping the partial inside the scan
 * tree means tests do not need to pass `--partial-file` explicitly — the
 * script's default resolves correctly off `--scan-root` alone.
 */
function writeHermeticPartial(scanRoot: string): void {
  const partialDir = path.join(scanRoot, 'scripts', 'house-rules');
  mkdirSync(partialDir, { recursive: true });
  const partialFile = path.join(partialDir, 'house-rules.md');
  writeFileSync(
    partialFile,
    [
      '# House rules',
      '',
      '<!-- hr:snapshot:start -->',
      FRAGMENT_SNAPSHOT,
      '<!-- hr:snapshot:end -->',
      '',
      '<!-- hr:no-config-api:start -->',
      FRAGMENT_NO_CONFIG_API,
      '<!-- hr:no-config-api:end -->',
      '',
      '<!-- hr:errors-tail:start -->',
      FRAGMENT_ERRORS_TAIL,
      '<!-- hr:errors-tail:end -->',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Options for {@link buildAgentBody}. Each field, if `true`, plants a
 * corresponding drift mode in the generated agent file. Defaults produce a
 * clean, byte-identical agent.
 */
interface AgentBuildOpts {
  // Replace the snapshot region's body with a drifted byte sequence.
  driftSnapshot?: boolean;
  // Strip the no-config-api sentinel pair entirely.
  missingNoConfigApi?: boolean;
  // Re-order the errors-tail sentinel pair (':end' before ':start').
  reorderedErrorsTail?: boolean;
  // Insert a second snapshot sentinel pair within the same file.
  duplicateSnapshot?: boolean;
  // Suppress the entire frontmatter block (no '---' opener).
  noFrontmatter?: boolean;
  // Omit the `tools:` line from the frontmatter.
  missingTools?: boolean;
  // Omit the `description:` line from the frontmatter.
  missingDescription?: boolean;
  // Emit `tools: ` with an empty value.
  emptyTools?: boolean;
  // Omit the `model:` line — used to assert `model` is optional.
  omitModel?: boolean;
}

/** Build a synthetic `agents/<name>.md` file body honouring `opts`. */
function buildAgentBody(opts: AgentBuildOpts = {}): string {
  const snapshotBody = opts.driftSnapshot ? '- DRIFTED BODY — not byte-identical.' : FRAGMENT_SNAPSHOT;
  const lines: string[] = [];

  // Frontmatter section. The drift modes either omit the whole block or
  // surgically remove / empty one required field.
  if (!opts.noFrontmatter) {
    lines.push('---');
    lines.push('name: gan-fixture');
    if (!opts.missingDescription) {
      lines.push('description: Fixture agent used by house-rules parity tests.');
    }
    if (opts.emptyTools) {
      lines.push('tools: ');
    } else if (!opts.missingTools) {
      lines.push('tools: Read, Write');
    }
    if (!opts.omitModel) {
      lines.push('model: opus');
    }
    lines.push('---');
    lines.push('');
  }

  // Body. The snapshot region's drift mode is exercised inline here.
  lines.push('## Inputs');
  lines.push('');
  lines.push('<!-- hr:snapshot:start -->');
  lines.push(snapshotBody);
  lines.push('<!-- hr:snapshot:end -->');
  lines.push('');
  // A duplicated snapshot pair is inserted immediately after the first when
  // requested — the parity check must catch that without needing distance.
  if (opts.duplicateSnapshot) {
    lines.push('<!-- hr:snapshot:start -->');
    lines.push(FRAGMENT_SNAPSHOT);
    lines.push('<!-- hr:snapshot:end -->');
    lines.push('');
  }

  lines.push('## Prohibitions');
  lines.push('');
  // missingNoConfigApi: skip the sentinel pair entirely. The script must
  // surface a HouseRulesRegionMissing finding for this name.
  if (!opts.missingNoConfigApi) {
    lines.push('<!-- hr:no-config-api:start -->');
    lines.push(FRAGMENT_NO_CONFIG_API);
    lines.push('<!-- hr:no-config-api:end -->');
    lines.push('');
  }

  lines.push('## Errors');
  lines.push('');
  // reorderedErrorsTail: emit ':end' before ':start' on consecutive lines.
  // The parity check must report HouseRulesRegionReordered.
  if (opts.reorderedErrorsTail) {
    lines.push('<!-- hr:errors-tail:end -->');
    lines.push(FRAGMENT_ERRORS_TAIL);
    lines.push('<!-- hr:errors-tail:start -->');
  } else {
    lines.push('<!-- hr:errors-tail:start -->');
    lines.push(FRAGMENT_ERRORS_TAIL);
    lines.push('<!-- hr:errors-tail:end -->');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Plant one fixture agent file at `<scanRoot>/agents/<name>.md` with the
 * given build options. Returns the absolute path so tests can assert on it
 * in stderr.
 */
function plantAgent(scanRoot: string, name: string, opts?: AgentBuildOpts): string {
  const agentsDir = path.join(scanRoot, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const abs = path.join(agentsDir, `${name}.md`);
  writeFileSync(abs, buildAgentBody(opts), 'utf8');
  return abs;
}

afterAll(() => {
  for (const r of tmpRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('house-rules bin', () => {
  it('clean canonical repo → exit 0; all 18 region checks + six frontmatter checks pass', async () => {
    const r = await runScript('house-rules', []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+ files scanned, 0 hits\n$/);
    expect(r.stderr).toBe('');
  });

  it('clean hermetic agent → exit 0', async () => {
    // Sanity check: the build-from-the-canonical-partial fixture itself
    // passes when nothing is drifted. Without this, a drift test that fails
    // could be failing because the clean baseline is broken, not because of
    // the planted drift.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    plantAgent(root, 'clean');

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^1 files scanned, 0 hits\n$/);
  });

  it('byte-drift inside one region body → exit 1; finding names agent + region', async () => {
    // Drift mode 1: the body between the sentinels diverged from the
    // canonical partial. This is the most common real-world failure.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    const planted = plantAgent(root, 'drift', { driftSnapshot: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('HouseRulesRegionDrift');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('hr:snapshot');
  });

  it('missing region (sentinel pair removed) → exit 1; finding names agent + region', async () => {
    // Drift mode 2: the sentinel pair is gone entirely. A maintainer
    // refactoring an agent's prohibition section might accidentally delete
    // the whole block; the parity check must catch it.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    const planted = plantAgent(root, 'missing', { missingNoConfigApi: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('HouseRulesRegionMissing');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('hr:no-config-api');
  });

  it('re-ordered sentinels (:end before :start) → exit 1; HouseRulesRegionReordered', async () => {
    // Drift mode 3: both sentinels present but in the wrong order. A
    // copy-paste during an edit can flip them; the parity check distinguishes
    // this from missing pairs so the message is actionable.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    const planted = plantAgent(root, 'reordered', { reorderedErrorsTail: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('HouseRulesRegionReordered');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('hr:errors-tail');
  });

  it('duplicated region within one file → exit 1; HouseRulesRegionDuplicated', async () => {
    // Drift mode 4: a second sentinel pair appears for the same region.
    // The check reports duplicated rather than "ok" because two pairs cannot
    // both be the canonical region; the script flags the ambiguity.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    const planted = plantAgent(root, 'duplicated', { duplicateSnapshot: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('HouseRulesRegionDuplicated');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('hr:snapshot');
  });

  it('missing required frontmatter field (tools dropped) → exit 1; AgentFrontmatterFieldMissing names tools', async () => {
    // Frontmatter drift 1: a required field's line is gone. A maintainer
    // editing the frontmatter to add a new key might accidentally delete
    // an existing one; the check ensures every shipped agent still carries
    // the three required keys.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    const planted = plantAgent(root, 'no-tools', { missingTools: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AgentFrontmatterFieldMissing');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('tools');
  });

  it('empty required frontmatter field (tools: ) → exit 1; AgentFrontmatterFieldEmpty', async () => {
    // Frontmatter drift 2: the line is present but the value is empty. The
    // distinction from "missing" matters because the fix is different —
    // populate the value vs. add the whole line — so the message is keyed
    // to a separate issue code.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    const planted = plantAgent(root, 'empty-tools', { emptyTools: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AgentFrontmatterFieldEmpty');
    expect(r.stderr).toContain(planted);
    expect(r.stderr).toContain('tools');
  });

  it('frontmatter omitted entirely → exit 1; AgentFrontmatterMissing names file', async () => {
    // Frontmatter drift 3: the whole '---' / '---' block is gone. A
    // non-agent `.md` file that landed under `agents/` (e.g. a stray README)
    // would surface here; the check ensures every `.md` under `agents/` is
    // a real subagent file.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    const planted = plantAgent(root, 'no-frontmatter', { noFrontmatter: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('AgentFrontmatterMissing');
    expect(r.stderr).toContain(planted);
  });

  it('frontmatter without model: line still passes — model is optional', async () => {
    // Control fixture: `model` is the only optional required-style field; the
    // parity check must NOT flag its absence. Without this test, narrowing
    // the required set to add `model` later would land silently.
    const root = newTmpRoot();
    writeHermeticPartial(root);
    plantAgent(root, 'no-model', { omitModel: true });

    const r = await runScript('house-rules', ['--scan-root', root]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^1 files scanned, 0 hits\n$/);
  });

  it('unknown flag → exit 64 with stderr pointer to --help', async () => {
    const r = await runScript('house-rules', ['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });

  it('--help prints help to stdout and exits 0', async () => {
    const r = await runScript('house-rules', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: house-rules');
    expect(r.stdout).toContain('--scan-root');
    expect(r.stdout).toContain('Exit codes');
  });

  it('--json on clean canonical repo → stdout parses as JSON with trailing newline', async () => {
    const r = await runScript('house-rules', ['--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      checked: number;
      failed: number;
      failures: unknown[];
    };
    expect(parsed.failed).toBe(0);
    expect(parsed.failures).toEqual([]);
    expect(typeof parsed.checked).toBe('number');
  });
});
