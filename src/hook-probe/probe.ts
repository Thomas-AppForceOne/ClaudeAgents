/**
 * Behaviour probe for the confinement hook. Synthesises a hermetic two-dir
 * temp tree, spawns the candidate hook with the framework's allow-listed
 * `trace/<run-id>.jsonl` target inside the synthesised `$GAN_RUN_DIR`, and
 * classifies the result into one of three verdicts:
 *
 * - `current`     — the hook exited 0 on the allow-listed write target
 *                   (honouring the F7 `$GAN_RUN_DIR` contract).
 * - `stale`       — the hook ran to completion and refused the write
 *                   (no `$GAN_RUN_DIR` awareness; the genuine pre-F7 case).
 * - `misconfigured` — the file is not a runnable bash script (no valid
 *                     shebang, not executable, or the spawn errored before
 *                     the hook could read stdin).
 *
 * The probe is the load-bearing detector. Both `gan hooks status` and the
 * skill-side preflight call the same {@link runConfineHookProbe} so the
 * acceptance-criteria-8 "byte-identical across surfaces" guarantee lives
 * at this single call site.
 *
 * Hermeticity contract stated once here so the call sites do not have to
 * restate it:
 * - The temp tree lives under `os.tmpdir()` with a `gan-confine-probe-<pid>-`
 *   prefix so parallel workers cannot collide on the prefix or race on
 *   hygiene assertions.
 * - The temp tree is removed in a `try/finally` `rm -rf` on every code path,
 *   including spawn failure and asynchronous exit.
 * - The spawn carries an **explicitly constructed** five-entry environment
 *   (PATH, GAN_RUN_ID, GAN_WORKTREE, GAN_RUN_DIR, CLAUDE_PROJECT_DIR) —
 *   never inherit-and-augment. `HOME`, `USER`, `SHELL`, and every other
 *   ambient operator-env value are deliberately excluded so the probe's
 *   classification cannot vary with operator machine state.
 * - The spawn uses `spawn` from `node:child_process` with an argv array, not
 *   `exec` with an interpolated shell command line, and the candidate
 *   hook path is the **command** (not an argument), so the untrusted
 *   filename never reaches a shell parser.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readSync, rmSync, statSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The verdict classes {@link runConfineHookProbe} surfaces.
 *
 * @see {@link ConfineProbeSubReason} for the per-verdict discriminator.
 */
export type ConfineProbeVerdict = 'current' | 'stale' | 'misconfigured';

/**
 * Per-verdict discriminator surfaced on the JSON result and the skill-side
 * preflight envelope.
 *
 * @value `'noGanRunDirAwareness'` paired with `verdict: 'stale'`: the hook
 *   ran to completion and refused the GAN_RUN_DIR-targeted write.
 * @value `'projectHookMisconfigured'` paired with `verdict: 'misconfigured'`:
 *   the file is not a runnable bash script.
 * @value `null` paired with `verdict: 'current'`: the hook accepted the
 *   probe and no remediation is required.
 */
export type ConfineProbeSubReason =
  | 'noGanRunDirAwareness'
  | 'projectHookMisconfigured'
  | null;

/**
 * Input to {@link runConfineHookProbe}.
 *
 * @property hookPath the absolute path to the candidate hook file. The
 *   probe spawns this path directly via `spawn` (no shell), so the path is
 *   the **command** argument; an attacker-controlled filename therefore
 *   cannot inject shell.
 */
export interface RunConfineHookProbeInput {
  hookPath: string;
}

/**
 * Result of {@link runConfineHookProbe}.
 *
 * @property verdict one of `'current'`, `'stale'`, or `'misconfigured'`.
 * @property subReason the per-verdict discriminator surfaced on the
 *   skill-side preflight envelope; `null` only when `verdict === 'current'`.
 */
export interface RunConfineHookProbeResult {
  verdict: ConfineProbeVerdict;
  subReason: ConfineProbeSubReason;
}

// Probe-target allow-list pin: the framework's current template
// (`scripts/hooks/gan-confine.sh.template`, case `trace/*`) explicitly
// allows any path under `<GAN_RUN_DIR>/trace/`. The probe targets a file
// inside `<GAN_RUN_DIR>/trace/` so a future template edit that removed the
// `trace/*` entry would surface as a unit-test failure at
// `tests/installer/confineHookProbe.test.ts` rather than silently
// misclassifying the framework's own template as `stale`.
const PROBE_TARGET_RELATIVE_PATH = path.join('trace', 'probe-event.jsonl');

// The synthetic run-id the probe injects. Matches the O2 run-id grammar
// `^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$` so the hook's first-line grammar check
// accepts it; the value is otherwise meaningless. Pinned to a fixed date
// far in the future so a casual log reader can tell it apart from a real
// run id.
const PROBE_RUN_ID = '20991231T235959-0000';

// Hermetic PATH the probe pins on the spawned hook's env. The list is an
// enumerated set of fixed directories chosen to make the probe's
// classification independent of the operator's machine:
//
//   /usr/bin            — POSIX-minimal: the framework's hook template
//                          relies on `grep`, `cat`, `dirname`, `awk`-class
//                          utilities that vendor installs ship here.
//   /bin                — POSIX-minimal companion: `sh`, `cat`-class
//                          binaries on Debian/Ubuntu derivatives (often a
//                          symlink to /usr/bin but historically distinct).
//   /usr/local/bin      — NodeSource convention on Linux: the `node` binary
//                          installed via `apt-get install nodejs` (NodeSource
//                          deb) lands here; the framework's hook template
//                          invokes `node -e` to parse the PreToolUse JSON.
//   /opt/homebrew/bin   — Homebrew convention on Apple Silicon macOS: the
//                          `node` binary installed via `brew install node`
//                          lands here on M1/M2 machines.
//
// Each entry is required so the framework's own hook template can locate
// `node` across the supported operator platforms. The list excludes every
// path that would re-introduce operator state (no `$HOME/.nvm/...`,
// no `path.dirname(process.execPath)`, no inherited PATH from the parent
// process). A hook that depends on a directory outside this list is by
// construction outside the framework's contract, and the probe correctly
// classifies it as `stale`.
const HERMETIC_PROBE_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';

// Maximum number of bytes read for the shebang sniff. Two bytes is the
// minimum useful (`#!`); reading a small prefix keeps the defensive check
// cheap and predictable regardless of file size.
const SHEBANG_SNIFF_BYTES = 4;

// Wall-clock cap on the spawned hook. A hook that does not exit within
// this many milliseconds is killed with SIGKILL and the probe resolves
// as `misconfigured`. The cap is the load-bearing protection against a
// hook that hangs (e.g. an operator-added `sleep infinity`, a `read`
// that never returns, or a child the hook fork-spawned and waited on
// without a timeout): without it, the skill-side preflight that runs
// `probeConfineHook` on every regular `/gan` invocation would block
// every sprint start on a single misbehaving project hook with no
// diagnostic. Five seconds is generous for a hook whose normal exit
// completes in milliseconds.
const PROBE_TIMEOUT_MS = 5_000;

// Maximum bytes the probe accepts from the spawned hook's stdout or
// stderr before SIGKILLing the child. A correctly-implemented hook
// produces little or no output on its allow-list write path. The cap
// prevents a runaway hook (e.g. `yes | head -c 1G`) from blowing up
// V8's heap inside the long-lived MCP server process that hosts
// `probeConfineHook`. The cap is intentionally generous (1 MiB) so a
// hook that logs a long error message before exiting is not
// misclassified, while still bounding the worst-case heap footprint.
const PROBE_STREAM_CAP_BYTES = 1_048_576;

/**
 * Run the behaviour probe against the candidate confinement hook.
 *
 * The function is exported as the single shared probe runner — both the CLI
 * `gan hooks status` command and the MCP `probeConfineHook` tool wrapper
 * call it without redoing any of the logic. The promise resolves with a
 * classification verdict in every code path: spawn failure, hook crash, and
 * normal exit all collapse to one of the three verdicts. The function never
 * throws.
 *
 * @param input see {@link RunConfineHookProbeInput}.
 * @returns a {@link RunConfineHookProbeResult}. Failure modes: an
 *   unreadable / non-bash hook is classified `misconfigured`; a non-zero
 *   exit on the allow-listed write target is classified `stale`; a zero
 *   exit is classified `current`. Side effect: creates a temp tree under
 *   `os.tmpdir()` whose prefix carries the current process id, and removes
 *   it in a `try/finally` `rm -rf` on every code path. The temp tree is
 *   removed even when the spawn errors before the hook runs.
 */
export async function runConfineHookProbe(
  input: RunConfineHookProbeInput,
): Promise<RunConfineHookProbeResult> {
  // Defensive shebang-check before spawn: a file that is not even readable
  // as bash text — empty, near-empty, or with no `#!` prefix — is
  // misconfigured by inspection. Avoiding a spawn for this case keeps the
  // probe from leaving an ambiguous "spawn errored" trace for the obvious
  // failure mode.
  const shebangCheck = checkShebangSync(input.hookPath);
  if (shebangCheck === 'unreadable' || shebangCheck === 'noShebang') {
    return { verdict: 'misconfigured', subReason: 'projectHookMisconfigured' };
  }

  // Tag the temp prefix with the current process id so parallel workers
  // never collide on a shared prefix, and a hygiene test that counts
  // probe-prefixed temp dirs cannot race against a sibling worker's
  // in-flight probe.
  const tempRoot = mkdtempSync(
    path.join(os.tmpdir(), `gan-confine-probe-${process.pid}-`),
  );
  try {
    const worktreeDir = path.join(tempRoot, 'worktree');
    const runDir = path.join(tempRoot, 'run');
    // Create both sibling dirs eagerly: the probe payload references both,
    // and a hook that consulted either path's existence (the framework's
    // hook does not, but a custom override might) sees a coherent tree.
    const fs = await import('node:fs');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'trace'), { recursive: true });

    const probeTarget = path.join(runDir, PROBE_TARGET_RELATIVE_PATH);

    // PreToolUse stdin envelope.
    //
    // Last-verified contract: https://docs.claude.com/en/docs/claude-code/hooks
    // checked against the docs on 2026-06-08. The envelope mirrors what
    // Claude Code passes to a real PreToolUse hook; if Claude Code changes
    // the shape, this envelope and the framework's own template need
    // updating in lockstep.
    const stdinPayload = JSON.stringify({
      session_id: '<probe>',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: probeTarget },
    });

    // Explicitly construct the hermetic env with exactly five keys. PATH
    // is an enumerated list of fixed directories the framework's own
    // hook template needs to discover its dependencies. The list is
    // operator-machine-agnostic: every directory is a literal string the
    // probe pins, so two operators on different machines see the same
    // PATH layout when the probe spawns the hook. Prepending
    // `path.dirname(process.execPath)` is explicitly avoided because it
    // would (a) make PATH operator-machine-dependent (NVM, fnm, Homebrew,
    // and system Node install at distinct directories), and (b) re-expose
    // every operator-installed binary co-located with the node executable
    // (e.g. an NVM `~/.nvm/versions/node/<v>/bin/` directory carrying
    // user-installed CLIs alongside `node`). HOME, USER, SHELL, and every
    // other ambient operator-env value are intentionally NOT forwarded: a
    // hook whose behaviour depended on those would make classification
    // non-deterministic across operators, and such a hook is by
    // construction outside the framework's contract — the probe
    // correctly classifies it as `stale`.
    const childEnv: Record<string, string> = {
      PATH: HERMETIC_PROBE_PATH,
      GAN_RUN_ID: PROBE_RUN_ID,
      GAN_WORKTREE: worktreeDir,
      GAN_RUN_DIR: runDir,
      CLAUDE_PROJECT_DIR: worktreeDir,
    };

    const exitCode = await spawnAndCollect(input.hookPath, childEnv, stdinPayload);
    if (exitCode === 'spawnError') {
      return { verdict: 'misconfigured', subReason: 'projectHookMisconfigured' };
    }
    if (exitCode === 0) {
      return { verdict: 'current', subReason: null };
    }
    return { verdict: 'stale', subReason: 'noGanRunDirAwareness' };
  } finally {
    // Hygiene contract: the temp tree is removed on every code path,
    // including a `throw` inside the try block above. `force: true` makes
    // the call idempotent so a partial cleanup (e.g. an interrupted spawn)
    // does not surface as a secondary error. The surrounding try/catch is
    // load-bearing for the function's "never throws" docstring contract:
    // an `rmSync` failure (e.g. EBUSY on a still-mapped file, EACCES on a
    // permission flip during NFS reconvergence) must not escape and crash
    // the long-lived MCP server that hosts `probeConfineHook`.
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the leaked temp tree will be reaped by the
      // operator's tmpfile cleaner. Swallowing the throw preserves the
      // never-throws contract for every caller.
    }
  }
}

/**
 * Synchronous shebang sniff. Reads up to {@link SHEBANG_SNIFF_BYTES} bytes
 * from the start of `hookPath` and decides whether the file is plausibly a
 * runnable bash script before the spawn is attempted.
 *
 * Three outcomes:
 * - `'ok'`         — the file begins with `#!`.
 * - `'noShebang'`  — the file is readable but does not begin with `#!`.
 * - `'unreadable'` — the file could not be opened (does not exist, no
 *                    permission, etc.).
 *
 * The check is synchronous to keep the call site simple — `mkdtempSync` and
 * `rmSync` on the same path are already synchronous, so an async sniff
 * would not improve responsiveness in any code path that matters.
 */
function checkShebangSync(hookPath: string): 'ok' | 'noShebang' | 'unreadable' {
  try {
    const st = statSync(hookPath);
    if (!st.isFile() || st.size < 2) {
      return 'noShebang';
    }
  } catch {
    return 'unreadable';
  }
  let fd: number;
  try {
    fd = openSync(hookPath, 'r');
  } catch {
    return 'unreadable';
  }
  try {
    const buf = Buffer.alloc(SHEBANG_SNIFF_BYTES);
    const bytes = readSync(fd, buf, 0, SHEBANG_SNIFF_BYTES, 0);
    if (bytes < 2) {
      return 'noShebang';
    }
    if (buf[0] !== 0x23 || buf[1] !== 0x21) {
      // 0x23 0x21 = '#!'. Any other lead byte sequence is not a script
      // shebang, regardless of the rest of the file.
      return 'noShebang';
    }
    return 'ok';
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort close: a failure here is irrelevant — the file
      // descriptor will be reaped when the process exits, and the
      // probe's correctness does not depend on the close succeeding.
    }
  }
}

// Sentinel for spawn-time failures the caller turns into `misconfigured`.
const SPAWN_ERROR = 'spawnError' as const;

// Spawn the hook with the explicit env and feed the stdin payload. Resolves
// with the numeric exit code on a normal exit, or with `SPAWN_ERROR` on
// any spawn-time failure (ENOENT, EACCES, ENOEXEC), on the
// `PROBE_TIMEOUT_MS` wall-clock cap firing, and on either stream
// exceeding `PROBE_STREAM_CAP_BYTES`. The function never throws: the only
// outcomes are an integer exit code or the sentinel.
async function spawnAndCollect(
  hookPath: string,
  env: Record<string, string>,
  stdin: string,
): Promise<number | typeof SPAWN_ERROR> {
  return await new Promise<number | typeof SPAWN_ERROR>((resolve) => {
    let child;
    try {
      // argv-form spawn: the candidate hook is the `command` argument, not
      // a string interpolated into a shell command line. `shell: false`
      // (the default) is reasserted by not passing the `shell` option at
      // all, so the untrusted filename never reaches a shell parser.
      child = spawn(hookPath, [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve(SPAWN_ERROR);
      return;
    }
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const settle = (value: number | typeof SPAWN_ERROR): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      // Drop the per-stream `data` listeners. The cleanup is
      // centralised here (rather than only in the cap-overflow
      // branch) so it covers all four resolve paths uniformly:
      //
      //   - cap-overflow path  → LOAD-BEARING. Subsequent in-flight
      //     chunks (bounded by the kernel pipe buffer between
      //     userspace and the child, but non-zero until SIGKILL is
      //     delivered and the OS closes the pipes) would otherwise
      //     keep growing the closure-held `stdoutBytes`/
      //     `stderrBytes` totals, defeating the heap bound the byte
      //     cap exists to enforce. With no `data` listener, Node's
      //     Readable flips back to paused mode and further chunks
      //     queue on the kernel pipe without being read into JS.
      //   - wall-clock-timeout path  → LOAD-BEARING for the same
      //     reason: the hanging hook may still be writing when
      //     SIGKILL is in flight.
      //   - normal-exit path  → HARMLESS. The streams have already
      //     emitted `end` and the listener set is effectively empty;
      //     removeAllListeners is a no-op. Keeping it in the shared
      //     settle path is the cost of one method call; the win is
      //     not having to remember which paths need cleanup.
      //   - spawn-error path  → HARMLESS. The streams were never
      //     attached to a running child.
      try {
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
      } catch {
        // `removeAllListeners` on Node's EventEmitter is documented
        // to return `this` and not throw; the catch is belt-and-
        // braces against a future refactor that wraps the stream in
        // a proxy whose semantics differ.
      }
      resolve(value);
    };
    // Defensive SIGKILL helper: the child may already be reaped (a kill
    // attempt on a dead process throws ESRCH on some platforms), so the
    // try/catch absorbs that race and the caller's `settle` runs either
    // way.
    const forceKill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The child is already gone; the 'exit' handler will fire (or has
        // fired) and either path settles the promise.
      }
    };
    // Wall-clock cap: see PROBE_TIMEOUT_MS. The cap exists so a single
    // hanging project hook cannot block every `/gan` sprint start on the
    // skill-side preflight. SIGKILL (not SIGTERM) so a hook that traps
    // termination signals still goes away.
    timeoutHandle = setTimeout(() => {
      forceKill();
      settle(SPAWN_ERROR);
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => settle(SPAWN_ERROR));
    child.on('exit', (code, signal) => {
      // A signal-only exit (no numeric code) is treated as a non-zero exit
      // — the hook did not run to completion, so the contract was not
      // satisfied. The status command surfaces this as `stale` rather than
      // `misconfigured` because the spawn itself succeeded.
      if (typeof code === 'number') {
        settle(code);
      } else if (signal !== null) {
        settle(1);
      } else {
        settle(1);
      }
    });
    // Drain stdout/stderr with a per-stream byte counter. A hook that
    // exceeds the cap on either stream is SIGKILLed and the probe resolves
    // as SPAWN_ERROR → `misconfigured`. The counters are per-stream so a
    // hook that splits a megabyte across both streams still exceeds the
    // cap on one of them. Without the cap, a runaway hook (`yes`-style)
    // would buffer unbounded chunks into V8 inside the long-lived MCP
    // server and OOM the process that the framework cannot recover.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > PROBE_STREAM_CAP_BYTES) {
          forceKill();
          settle(SPAWN_ERROR);
        }
      });
    }
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > PROBE_STREAM_CAP_BYTES) {
          forceKill();
          settle(SPAWN_ERROR);
        }
      });
    }
    if (child.stdin !== null) {
      try {
        child.stdin.end(stdin);
      } catch {
        // A write failure here is rare; the `error` event above resolves
        // the promise as `SPAWN_ERROR`. Swallow the synchronous throw so
        // the promise resolves through the event path rather than crashing.
      }
    }
  });
}
