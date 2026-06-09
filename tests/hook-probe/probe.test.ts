/**
 * Probe-runner classification tests.
 *
 * The shared probe runner at `src/hook-probe/probe.ts` is the
 * single load-bearing detector both `gan hooks status` and the skill-side
 * preflight invoke. The four candidate cases drive the contract directly:
 *
 *   (a) framework's current rendered template → `current`
 *   (b) pre-F7 hook (no GAN_RUN_DIR awareness)  → `stale`
 *   (c) hand-written permissive hook            → `current`
 *   (d) non-bash file (no valid shebang)        → `misconfigured`
 *
 * Tests also pin filesystem hygiene (`mkdtempSync` temp tree is removed
 * after every classification path; the `gan-confine-probe-<pid>-*` prefix
 * scan post-count is `<= pre-count`) and the probe-target allow-list
 * (the rendered template's allow-list still contains the probe-target's
 * matching entry, so a future template edit that removes it surfaces here
 * rather than silently misclassifying the framework's own template).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runConfineHookProbe } from '../../src/hook-probe/probe.js';
import { repoRootDir } from '../installer/helpers/spawn.js';
import { renderedTemplate } from '../installer/helpers/confineTemplate.js';

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

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

// Snapshot the set of probe-prefixed temp dirs that exist right now. The
// snapshot is intersected with the set the test took before the call
// runs, so a sibling worker's probe (Vitest worker threads share this
// process's pid, so the prefix is shared) does not appear as debris
// attributable to this test's call. The check then proves the specific
// `try/finally rm` path the probe runner uses cleans up after itself —
// the spec's "after each classification path" guarantee — without
// race-prone exclusive ownership of the prefix.
function snapshotProbeTempDirs(): Set<string> {
  const prefix = `gan-confine-probe-${process.pid}-`;
  try {
    return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith(prefix)));
  } catch {
    return new Set();
  }
}

// Assert that the call cleaned up after itself by polling: a sibling
// worker's still-in-flight probe dir is allowed to exist in the snapshot
// taken right after the call, but if it is truly a sibling's it will
// disappear shortly. We poll for up to `MAX_DEBRIS_WAIT_MS` and accept
// the assertion as soon as the set of fresh dirs is empty.
async function assertNoNewDebris(before: Set<string>, after: Set<string>): Promise<void> {
  const MAX_DEBRIS_WAIT_MS = 1500;
  const POLL_INTERVAL_MS = 50;
  const start = Date.now();
  let fresh: string[] = freshDirs(before, after);
  while (fresh.length > 0 && Date.now() - start < MAX_DEBRIS_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    fresh = freshDirs(before, snapshotProbeTempDirs());
  }
  if (fresh.length > 0) {
    throw new Error(
      `probe left ${fresh.length} new temp dir(s) attributable to its call: ${fresh.join(', ')}`,
    );
  }
}

function freshDirs(before: Set<string>, after: Set<string>): string[] {
  const out: string[] = [];
  for (const name of after) {
    if (!before.has(name)) out.push(name);
  }
  return out;
}

// Stage a hook file under a tmp dir with the given content and exec mode.
function stageHook(content: string, mode = 0o755): string {
  const dir = makeTmpDir('gan-confine-probe-test-');
  const hookPath = path.join(dir, 'gan-confine.sh');
  writeFileSync(hookPath, content);
  chmodSync(hookPath, mode);
  return hookPath;
}

// A hand-written permissive hook: accepts every input and returns 0. The
// shape mirrors the spec's case (c): an override the framework cannot tell
// apart from a deliberate "allow everything" policy.
const PERMISSIVE_HOOK = '#!/bin/bash\nexit 0\n';

// A pre-F7 hook: refuses every write outright. The probe's allow-listed
// GAN_RUN_DIR target is denied → stale.
const PRE_F7_HOOK = '#!/bin/bash\nexit 1\n';

// A non-bash file (binary content, no shebang). The probe's defensive
// shebang sniff classifies this as `misconfigured` without spawning.
const NON_BASH_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f, 0x80]);

describe('runConfineHookProbe — four-case classification matrix', () => {
  it("(a) framework's current rendered template → 'current'", async () => {
    const hookPath = stageHook(renderedTemplate());
    const pre = snapshotProbeTempDirs();
    const result = await runConfineHookProbe({ hookPath });
    const post = snapshotProbeTempDirs();
    expect(result.verdict).toBe('current');
    expect(result.subReason).toBe(null);
    // Hygiene: the temp tree is removed on every code path.
    await assertNoNewDebris(pre, post);
  });

  it("(b) pre-F7 hook with no GAN_RUN_DIR awareness → 'stale'", async () => {
    const hookPath = stageHook(PRE_F7_HOOK);
    const pre = snapshotProbeTempDirs();
    const result = await runConfineHookProbe({ hookPath });
    const post = snapshotProbeTempDirs();
    expect(result.verdict).toBe('stale');
    expect(result.subReason).toBe('noGanRunDirAwareness');
    await assertNoNewDebris(pre, post);
  });

  it("(c) hand-written permissive hook that allows everything → 'current'", async () => {
    const hookPath = stageHook(PERMISSIVE_HOOK);
    const pre = snapshotProbeTempDirs();
    const result = await runConfineHookProbe({ hookPath });
    const post = snapshotProbeTempDirs();
    expect(result.verdict).toBe('current');
    expect(result.subReason).toBe(null);
    await assertNoNewDebris(pre, post);
  });

  it("(d) non-bash file (no valid shebang) → 'misconfigured'", async () => {
    const dir = makeTmpDir('gan-confine-probe-test-');
    const hookPath = path.join(dir, 'gan-confine.sh');
    writeFileSync(hookPath, NON_BASH_BYTES);
    chmodSync(hookPath, 0o755);
    const pre = snapshotProbeTempDirs();
    const result = await runConfineHookProbe({ hookPath });
    const post = snapshotProbeTempDirs();
    expect(result.verdict).toBe('misconfigured');
    expect(result.subReason).toBe('projectHookMisconfigured');
    await assertNoNewDebris(pre, post);
  });

  it("an absent hook path → 'misconfigured' without spawning", async () => {
    const dir = makeTmpDir('gan-confine-probe-test-');
    const hookPath = path.join(dir, 'does-not-exist.sh');
    const result = await runConfineHookProbe({ hookPath });
    expect(result.verdict).toBe('misconfigured');
    expect(result.subReason).toBe('projectHookMisconfigured');
  });
});

describe('runConfineHookProbe — probe-target allow-list pin', () => {
  // The probe synthesises a write target inside the synthetic GAN_RUN_DIR
  // whose relative path matches one of the framework's current template's
  // allow-list entries. The pin: read the rendered template, scan for the
  // case glob the probe-target path matches, and assert the entry is
  // present. A future template edit that removes the entry surfaces here
  // rather than silently misclassifying the framework's own template.
  it("the rendered template's allow-list still contains the probe-target's matching entry", () => {
    const tpl = renderedTemplate();
    // The probe-target relative path is `trace/probe-event.jsonl`; the
    // matching template entry is the `trace/*) exit 0 ;;` line in the
    // case ladder. The pin scans for that exact entry as a substring.
    expect(tpl).toContain('trace/*) exit 0 ;;');
  });
});

describe('runConfineHookProbe — filesystem hygiene under stress', () => {
  // Run all four classification cases sequentially and assert the
  // probe-prefixed temp dir count never grows past the pre-test
  // baseline. This is the belt-and-braces sweep: any code path that
  // skipped the `try/finally` rm would leak a single dir, which the
  // post-count would catch.
  it('repeated classifications leave no probe-prefixed temp debris', async () => {
    const baseline = snapshotProbeTempDirs();
    const cases: string[] = [
      renderedTemplate(),
      PRE_F7_HOOK,
      PERMISSIVE_HOOK,
    ];
    for (const content of cases) {
      const hookPath = stageHook(content);
      await runConfineHookProbe({ hookPath });
    }
    // Also exercise the non-bash branch (which skips the spawn).
    const dir = makeTmpDir('gan-confine-probe-test-');
    const nonBashPath = path.join(dir, 'gan-confine.sh');
    writeFileSync(nonBashPath, NON_BASH_BYTES);
    await runConfineHookProbe({ hookPath: nonBashPath });
    await assertNoNewDebris(baseline, snapshotProbeTempDirs());
  });
});

// Sanity check the template helper is genuinely substituting and not
// returning a literal `__GAN_FRAMEWORK_VERSION__` placeholder. Without
// this check a refactor of `confineTemplate.ts` that broke substitution
// could let the probe spuriously classify the framework's own template
// as `misconfigured`.
describe('renderedTemplate — version substitution sanity', () => {
  it('substitutes the __GAN_FRAMEWORK_VERSION__ placeholder', () => {
    const tpl = renderedTemplate();
    const pkg = JSON.parse(
      readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(tpl).toContain(`version ${pkg.version}.`);
    expect(tpl).not.toContain('__GAN_FRAMEWORK_VERSION__');
  });
});

// The criterion: the probe's child env PATH MUST be an enumerated set
// of literal directories that does not vary across operator machines.
// The earlier `${path.dirname(process.execPath)}` prepend re-exposed
// operator-installed binaries co-located with the node executable and
// made classification machine-dependent.
describe('runConfineHookProbe — child env PATH is hermetic and machine-independent', () => {
  it("the probe spawns a hook that observes a literal enumerated PATH", async () => {
    // A custom hook prints the PATH it sees on stdout, then accepts
    // the probe target so the probe's three-state classification
    // collapses to a definitive answer. The test reads the printed
    // PATH off the file the hook writes — the only env-snapshotting
    // surface available without modifying the probe to expose its
    // env construction directly.
    const dir = makeTmpDir('gan-confine-probe-path-');
    const sentinel = path.join(dir, 'observed-path');
    const hookPath = path.join(dir, 'gan-confine.sh');
    // The hook writes "$PATH" verbatim to the sentinel and exits 0.
    // The probe targets a path under `<runDir>/trace/`, which this
    // hook ignores; the probe's verdict is `current` because the
    // hook exited 0 on the target.
    const hookSource =
      '#!/bin/bash\n' +
      `printf '%s' "$PATH" > '${sentinel}'\n` +
      'exit 0\n';
    writeFileSync(hookPath, hookSource);
    chmodSync(hookPath, 0o755);
    const result = await runConfineHookProbe({ hookPath });
    expect(result.verdict).toBe('current');
    const observed = readFileSync(sentinel, 'utf8');
    // The literal enumerated list the probe pins: POSIX-minimal +
    // NodeSource + Homebrew. Asserting on the exact string proves the
    // probe is NOT prepending `process.execPath`'s parent (which
    // would vary across NVM, Homebrew, fnm, system Node).
    expect(observed).toBe('/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin');
    // Belt-and-braces: the PATH does NOT contain the parent directory
    // of the current node executable. Were the prepend still in
    // place, this directory would appear at the front of PATH and
    // make the probe machine-dependent.
    const nodeParent = path.dirname(process.execPath);
    expect(observed).not.toContain(nodeParent);
  });
});

// The criterion: the probe's spawn carries a wall-clock cap (per
// PROBE_TIMEOUT_MS) and per-stream byte caps (per
// PROBE_STREAM_CAP_BYTES). Without them, a single misbehaving project
// hook would block every `/gan` sprint start on the skill-side
// preflight or OOM the long-lived MCP server that hosts
// `probeConfineHook`. The cap is the load-bearing protection.
describe('runConfineHookProbe — runaway hook caps', () => {
  it('a hook that hangs is killed and classified as misconfigured', async () => {
    // The hook sleeps far longer than the probe's wall-clock cap. The
    // probe must SIGKILL the child and resolve as `misconfigured`
    // rather than wait. Total test wall-clock budget is ~6s (5s probe
    // cap + small overhead); the cap defends both the test and the
    // production preflight from a hanging hook.
    const hookSource = '#!/bin/bash\nsleep 60\n';
    const hookPath = stageHook(hookSource);
    const start = Date.now();
    const result = await runConfineHookProbe({ hookPath });
    const elapsed = Date.now() - start;
    expect(result.verdict).toBe('misconfigured');
    expect(result.subReason).toBe('projectHookMisconfigured');
    // Allow generous slack (the probe cap is 5s plus per-OS SIGKILL
    // reap time); the test only asserts we do NOT wait for the 60s
    // sleep. A regression that drops the timeout would surface as a
    // test-runner-killing 60s wait.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('a hook that floods stdout past the byte cap is killed', async () => {
    // `yes` is universally available on POSIX; piping its output to
    // `head -c 2M` (2 MiB) doubles the probe's 1 MiB stream cap so
    // even a generous interpretation of `cap > 1 MiB` is exceeded.
    // The probe must SIGKILL the child before completion and
    // classify as misconfigured. The test does NOT depend on which
    // stream (stdout or stderr) trips the cap; redirecting the flood
    // to stderr would prove the same property.
    const hookSource = '#!/bin/bash\nyes | head -c 2097152\nexit 0\n';
    const hookPath = stageHook(hookSource);
    const start = Date.now();
    const result = await runConfineHookProbe({ hookPath });
    const elapsed = Date.now() - start;
    expect(result.verdict).toBe('misconfigured');
    expect(result.subReason).toBe('projectHookMisconfigured');
    // The kill should land well before the wall-clock cap; a flood
    // of 2 MiB through a pipe completes in milliseconds, so the
    // probe should resolve quickly even though the cap is 5s.
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});
