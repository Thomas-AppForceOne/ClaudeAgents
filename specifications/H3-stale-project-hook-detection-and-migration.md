# H3 — Stale project-tier confinement hook detection and migration

## Problem

H1 introduced the framework-owned confinement hook and acknowledged
that project-tier overrides at `<project>/.claude/hooks/gan-confine.sh`
are the project's responsibility — the framework writes the user-tier
hook at `~/.claude/hooks/gan-confine.sh` and refreshes it on every
`install.sh` run, but does not touch project-tier copies. H1 envisioned a
`gan hooks status` command that "prints the user-tier hook path, any
project-tier hook in the current directory, the framework version that
authored the user-tier hook, and a hint about deletion when the
project-tier hook predates F1's zone rework."

F7 then changed the framework's filesystem contract: run data moved out of
`.gan-state/runs/<id>/` (a project-tree path) into a central, repo-keyed
store at `~/.gan-runs-data/<repo-key>/runs/<run-id>/`, exposed to the hook
through a new `$GAN_RUN_DIR` environment variable. The framework's hook
template at `scripts/hooks/gan-confine.sh.template` was updated to honour
both `$GAN_WORKTREE` and `$GAN_RUN_DIR` as allowed zones.

H1's migration guidance covered the **F1 →
F1-with-`.gan-state/`** transition. **It did not cover the F7
transition**, and the project-tier-override warning H1 anticipated has not
been observed to fire on hooks that predate F7. As a result, a project
that adopted the framework before F7 landed can be running a project-tier
hook that:

- Allows writes inside `$GAN_WORKTREE` (correct under both pre- and
  post-F7 contracts).
- Allows writes inside `<repo>/.gan/` (an F1-era zone; harmless when
  empty but no longer the framework's run-data location).
- Does **not** allow writes inside `$GAN_RUN_DIR` (the central-store
  artefact directory the orchestrator now writes to).

Every artefact the clarifier, planner, proposer, generator, evaluator,
and reviewer produces lands in `$GAN_RUN_DIR`. The stale project-tier
hook refuses each of these writes. The first symptom is a sub-agent
returning a structured `PreToolUse:Write hook error` mid-attempt with a
message of the form:

> GAN CONFINEMENT: Write refused — target
> `<GAN_RUN_DIR>/clarified-spec.md` is outside `<GAN_WORKTREE>` (and not
> a harness metadata file under `<repo>/.gan/`)

Three properties of this failure compound:

1. **No early warning.** `install.sh` does not flag the hook as stale.
   `/gan` does not warn that the active project-tier hook diverges from
   the framework's F7-aware template before the first agent fires. The
   first signal the operator sees is a sprint already in flight aborting
   on a write the framework expected to succeed.
2. **Cryptic message.** The denial message points the operator at
   `$GAN_WORKTREE` and tells them the artefact is "outside" it — but
   `$GAN_RUN_DIR` is *deliberately* outside the worktree per F7's
   centralisation. The operator has no breadcrumb explaining that the
   framework moved the run data and the hook hasn't caught up.
3. **No remediation prompt.** The operator must independently know that
   the legacy hook is the cause, decide whether to delete it (so the
   user-tier framework hook applies), update it by hand, or override
   confinement for the run. No tool surfaces those choices.

A dogfooding `/gan` run hit this on 2026-06-08: the clarifier aborted
because a legacy project-tier hook denied the write to its
`$GAN_RUN_DIR/clarified-spec.md`. Diagnosis required reading both the
hook source and H1's spec, and the operator's only escape was to
disable confinement entirely for the run — sacrificing the
defence-in-depth H1 was written to provide.

The structural problem: **the framework changed the hook's contract in
F7 but did not ship a detection mechanism for project-tier hooks that
lag behind the new contract.** H1 anticipated the migration challenge
abstractly; F7 made it concrete; no spec closed the loop. H3 closes it.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes. The detection-and-migration
   surface extends R3's `gan` CLI (a `gan hooks` subcommand surface),
   reuses the existing `packageRoot()` resolver
   (`src/config-server/package-root.ts`) to locate the framework's
   current hook template at runtime, and rides H1's user-tier hook
   already in place. No new framework primitives are introduced.
2. **Composable?** Yes. Detection reuses C5's tier-resolution model
   (project-tier vs. user-tier path lookup). The migration writer uses
   the standard atomic temp-file-plus-rename pattern (the same shape
   `install.sh` uses for its own atomic writes) and a per-operation
   timestamped backup sibling for rollback — see §2 below. The skill-
   side diagnostic reuses the orchestrator's existing structured-error
   surfacing.
3. **Owns durable, structured state?** No — H3 is a diagnostic and
   migration surface only. The state it inspects is on-disk hook files;
   the state it writes is the same `~/.claude/hooks/gan-confine.sh` and
   `<project>/.claude/hooks/gan-confine.sh` H1 already governs.
4. **Closes a regression class?** Yes. Every future framework change to
   the hook's contract benefits from the same detection: any
   project-tier hook that fails the probe is surfaced, regardless of
   which contract version it lags.
5. **Reuses existing diagnostics?** Yes. The `ConfigApiUnreachable`
   preflight model (skill-level preflight that emits structured JSON
   with `code` + `subReason` + `message`) is the template H3's
   orchestrator-side warning follows.

## Proposed change

H3 ships three coordinated surfaces: a CLI inspection command, a CLI
migration command, and a skill-side preflight. Each is small; together
they close the gap.

### 1. `gan hooks status`

H1 promised a `gan hooks status` command. H3 specifies it concretely and
extends it to detect F7 staleness (and any future contract change).

**Project-root resolution.** Both `gan hooks status` and
`gan hooks migrate` resolve the project root via the existing
`resolveProjectRoot` helper at `src/cli/lib/project-root.ts` — the
same resolver every other `gan` subcommand uses (`gan config print`,
`gan stacks list`, `gan trust info`). The resolver takes
`--project-root <path>` when given and defaults to the current working
directory; it canonicalizes the path and validates that it exists and
is a directory. The `<project>` placeholder used throughout this spec
is shorthand for the resolved root. The skill-side preflight (§3
below) passes its already-resolved `projectRoot` to the
`probeConfineHook` MCP tool, so the orchestrator does not re-resolve.

**Output shape.** A `--json`-able read subcommand under R3's `gan` CLI:

```
$ gan hooks status
User-tier hook:    ~/.claude/hooks/gan-confine.sh
  framework version:  0.6.0
  contract revision:  F7 (knows GAN_RUN_DIR)
  Claude Code reg:    registered in ~/.claude/settings.json
Project-tier hook: <project>/.claude/hooks/gan-confine.sh
  framework version:  unknown (no version banner)
  contract revision:  pre-F7 (no GAN_RUN_DIR awareness detected)
  Claude Code reg:    overrides user-tier (project takes precedence)

  ⚠  The project-tier hook lags the framework's current contract.
     A `/gan` run will fail mid-sprint when an agent tries to write
     into the central-store run directory `~/.gan-runs-data/...`.

     If the project-tier hook is a copy of a prior framework hook,
     delete it — the user-tier framework hook will apply automatically:
       rm <project>/.claude/hooks/gan-confine.sh

     If the project-tier hook is a deliberate override, run
     `gan hooks migrate --review` to see the diff against the
     framework's current template, and update by hand.
```

**Contract-revision detection.** Two stacked heuristics. The behaviour
probe is the load-bearing detector — the banner heuristic is a fast
first read whose verdict is **always superseded** by the probe when the
two disagree, regardless of direction (`matches`, `lags`, or `ahead`).

- **Header banner match (preferred read; advisory only).** The
  framework's template carries a version banner (`# Source of truth:
  ClaudeAgents framework, version <semver>.`). The parser matches it
  with the regex `/^# Source of truth: ClaudeAgents framework, version
  (\S+)\.\s*$/m`. First match wins (multi-banner files take the first
  occurrence). Semver prerelease (`1.4.0-rc.1`) and build-metadata
  (`1.4.0+sha.abc`) suffixes are stripped before the pivot comparison;
  the major.minor.patch core determines the pivot. Empty file, missing
  banner, and unparseable semver all yield `version: null,
  contractRevision: 'unknown'`. The parser never throws on any byte
  sequence (including binary content) — a parse failure is a verdict,
  not an exception.

  When the banner is present and parses, the contract revision is
  derived from the framework's version mapping, anchored on **F7's
  actual ship version, 0.1.0** (PR #23): `< 0.1.0` → `F1`; `>= 0.1.0`
  → `F7`. The framework's installed template version is also checked
  so the comparison surfaces `lags` / `matches` / `ahead` — the last
  surfaces when an operator has not yet rerun `install.sh` after
  upgrading the framework.

  The contract-revision table is encoded as a single `const` in
  `src/cli/lib/confine-hook-banner.ts`:

  ```typescript
  const CONTRACT_REVISION_PIVOTS = [
    { minVersion: '0.0.0', contractRevision: 'F1' },
    { minVersion: '0.1.0', contractRevision: 'F7' },
  ] as const;
  ```

  Lookup is a binary search picking the highest `minVersion ≤ parsed
  version`. A future hook-contract change appends a row at the
  relevant `minVersion`; no schema, registry, or data file is
  required. F8 (centralized module-state store, PR #24) shipped
  without changing the hook contract and introduces no new row.

- **Behaviour probe (load-bearing).** Synthesises a probe input: a JSON
  payload on stdin matching Claude Code's PreToolUse contract, with
  `GAN_RUN_ID` set to a known-good run-id grammar, `GAN_WORKTREE` set
  to a temp directory, `GAN_RUN_DIR` set to a sibling temp directory,
  and the tool invocation targeting a path inside `$GAN_RUN_DIR` that
  the framework's current template lists in its allow-list (the
  implementation pins the probe target against the template's allow-
  list — see "Risks and decisions" below). The hook's exit code is
  recorded. A hook that returns non-zero on this probe is flagged
  "pre-F7 (no GAN_RUN_DIR awareness detected)"; a hook that returns
  zero is flagged "F7-aware (probe passes)". The probe runs in an
  ephemeral working directory and never touches real run data, and
  always runs — even when the banner is present and parses cleanly —
  so the banner-claims-current-but-probe-fails case (a hand-edited hook
  that kept the banner but lost the allow-list) is detected.

**Claude Code registration detection.** The "Claude Code reg" lines
are derived from a single read of `~/.claude/settings.json`. The
status command walks `data.hooks.PreToolUse[].hooks[]` looking for an
entry whose canonicalized `command` field equals the canonicalized
user-tier hook path `~/.claude/hooks/gan-confine.sh` **exactly**
(canonical-path equality, not `endsWith` — to avoid false positives
against unrelated entries ending in the same filename). A match →
"registered in ~/.claude/settings.json"; no match → "not registered".
A framework-installed hook is registered by construction (see
`install.sh`'s `merge_claude_settings` block at `install.sh:644`); a
"not registered" verdict indicates a manual settings edit removed the
entry.

**Misconfigured-with-parseable-banner edge case.** A file flagged
`misconfigured` (non-bash, no valid shebang, fails to spawn) may still
match the banner regex by accident — a binary file or a non-bash
script can contain the banner-text byte sequence. The JSON output
surfaces both: `bannerVerdict` and `frameworkVersion` reflect the
banner read; `probeVerdict` is `"misconfigured"`. Probe-wins resolves
the top-level `verdict` to `"misconfigured"`. The remediation hint
treats the file as misconfigured (the operator should fix or remove
it), not as a stale-contract case.

The project-tier "overrides user-tier (project takes precedence)" line
is **not** derived from a project-scoped `settings.json` read — Claude
Code's hook precedence is file-existence at `<project>/.claude/hooks/`.
A file present at `<project>/.claude/hooks/gan-confine.sh` is invoked
by Claude Code in preference to the user-tier hook regardless of
settings.json content. The status command therefore reports
"overrides user-tier" whenever the project-tier file exists, and the
skill-side preflight uses the same existence-at-path signal — the two
surfaces agree on what "project-tier hook" means.

**JSON output (`--json`).** The same data the human-readable output
surfaces is also available as structured JSON via `gan hooks status
--json`. The shape is stable for v1.0:

```json
{
  "userTier": {
    "path": "/Users/<you>/.claude/hooks/gan-confine.sh",
    "frameworkVersion": "0.6.0",
    "contractRevision": "F7",
    "registered": true
  },
  "projectTier": null,
  "verdict": "current"
}
```

When a project-tier hook is present:

```json
{
  "userTier": { "path": "...", "frameworkVersion": "0.6.0", "contractRevision": "F7", "registered": true },
  "projectTier": {
    "path": "/Users/<you>/path/to/project/.claude/hooks/gan-confine.sh",
    "frameworkVersion": null,
    "contractRevision": "unknown",
    "bannerVerdict": "absent",
    "probeVerdict": "stale",
    "verdict": "stale",
    "backupSiblings": [
      "/Users/<you>/path/to/project/.claude/hooks/gan-confine.sh.gan-bak.2026-06-08T19:42:11Z"
    ]
  },
  "verdict": "stale"
}
```

Field contracts:

- `userTier.frameworkVersion` and `projectTier.frameworkVersion` are
  semver strings or `null` (absent or unparseable banner). The text
  output displays `unknown` for the no-banner case; **the JSON
  output uses `null`** and only `null` — implementations must not
  emit the string `"unknown"` here.
- `contractRevision` is one of `"F1"`, `"F7"`, `"unknown"`. (Three
  values; `"unknown"` is the literal JSON string for the no-banner
  case, matching the text-output label.)
- `bannerVerdict` is one of `"matches"`, `"lags"`, `"ahead"`,
  `"absent"`, `"unparseable"`. `matches` / `lags` / `ahead` fire when
  a banner parsed and the parsed version was compared against the
  installed framework version. `absent` fires when no banner was
  found in the file. `unparseable` fires when a banner was found but
  its semver did not parse.
- `probeVerdict` is one of `"current"`, `"stale"`, `"misconfigured"`.
- Per-tier `verdict` is the probe-wins resolution against that tier.
  Top-level `verdict` reflects `projectTier.verdict` when a project-
  tier hook is present, otherwise `current` (the user-tier hook is
  not probed: `install.sh` refreshes it on every run and the
  framework treats it as authoritative-by-construction; the user
  tier therefore carries no `verdict` field and is not the source of
  the top-level resolution).
- `projectTier.backupSiblings` lists any
  `gan-confine.sh.gan-bak.<timestamp>` files present in
  `<project>/.claude/hooks/`. Present-and-empty (`[]`) when the hook
  directory exists but holds no backup siblings. The field is scoped
  to the project-tier object because backup siblings are artefacts of
  `migrate` operations on the project-tier hook.

  **Orphan-backup case.** When `projectTier` is `null` (no hook file)
  but backup siblings still exist in `<project>/.claude/hooks/` (the
  operator manually deleted the project-tier hook after a prior
  `migrate`), the JSON adds a top-level `orphanBackupSiblings`
  string array carrying the same paths. The human output surfaces a
  one-line warning under the user-tier block: `Backup siblings
  present at <project>/.claude/hooks/ from prior migrate
  operations: N. Delete manually if no longer needed.`

No new file under `schemas/` is added; the shape is the CLI contract
and is asserted by `tests/cli/hooks/status.test.ts`. Forward-compat
fields may be added to the object but no existing field is renamed or
removed without a major bump.

**Exit code.** `gan hooks status` exits `0` when no project-tier hook is
detected, or when the project-tier hook matches the current contract; it
exits with the R3 mapped `2` (validation failure) when a stale
project-tier hook is detected, and with the same `2` when the project-
tier hook is `misconfigured` (not a runnable bash script). The non-zero
exit is what lets CI gate on hook hygiene.

### 2. `gan hooks migrate`

A second subcommand offers three deterministic actions for a stale
project-tier hook:

- `gan hooks migrate --delete` — removes
  `<project>/.claude/hooks/gan-confine.sh` after confirming with the
  operator. The framework's user-tier hook then applies. Use case: the
  project-tier file is a stale copy of an older framework hook, not a
  deliberate override.
- `gan hooks migrate --replace` — overwrites
  `<project>/.claude/hooks/gan-confine.sh` with the framework's current
  template (the same content `install.sh` writes to the user-tier
  path). Use case: the operator wants to keep a project-tier copy for
  policy reasons (e.g. CI compatibility) but accepts the framework's
  current contract verbatim. The replaced hook gains the framework's
  version banner so future `gan hooks status` calls succeed via the
  banner heuristic.
- `gan hooks migrate --review` — prints the unified diff between the
  current project-tier hook and the framework's current template to
  stdout, then exits 0 without writing anything. Use case: the operator
  knows the hook is a deliberate override and needs to merge changes by
  hand.

**Absent-project-tier-hook edge cases.** Each action has a defined
behaviour when no file exists at `<project>/.claude/hooks/gan-confine.sh`:

- `--delete` is an **idempotent no-op**: prints `no project-tier hook
  present at <path>; nothing to delete` and exits 0. No backup
  sibling is created.
- `--review` prints `no project-tier hook present at <path>; nothing
  to diff` and exits 0. No backup sibling is created.
- `--replace` **creates** the project-tier hook from the framework's
  current template, treating the operator-intent as "I want a
  project-tier copy to start from." The created file carries the
  framework version banner. No prior content existed, so no backup
  sibling is written; the stdout message names the created path only
  (`created <path>`) and omits the backup line.

The `<project>/.claude/hooks/` directory is created on demand by
`--replace` when absent (via `mkdir -p`-equivalent); the create
operation is wrapped in the same atomic temp+rename pattern so a
partial directory creation cannot land a half-written hook.

**Rollback via timestamped backup sibling.** `install.sh`'s
`STATE_LOG` is process-internal (a bash array, never persisted) so
does not extend to standalone CLI operations. `gan hooks migrate`
uses a per-operation backup-sibling pattern instead:

- Before `--delete` unlinks the project-tier hook, it copies the file
  contents to `<project>/.claude/hooks/gan-confine.sh.gan-bak.<utc-iso-
  timestamp>` via an atomic temp+rename (write to
  `gan-confine.sh.gan-bak.<timestamp>.tmp.<pid>`, then `rename` onto the
  final backup filename). Only after the backup rename succeeds does
  the original path get unlinked. A crash between the backup and the
  unlink leaves both files on disk; the operator either re-runs
  `--delete` (idempotent — the new backup just gets a later timestamp,
  and the original file is unlinked) or keeps the original. A crash
  before the backup completes leaves the original untouched.

- `--replace` follows the same shape: backup-then-replace. The
  replacement is written to `gan-confine.sh.tmp.<pid>` and renamed
  onto the original path only after the backup-sibling rename
  succeeds.

- The backup-sibling filename is printed to stdout on every successful
  `--delete` or `--replace` so the operator has the rollback path in
  hand: `mv <project>/.claude/hooks/gan-confine.sh.gan-bak.<timestamp>
  <project>/.claude/hooks/gan-confine.sh` restores the prior content.
  Rollback is a manual operator action; no `gan hooks rollback`
  subcommand ships in v1.0.

- `--review` is a pure read and writes no backup.

`atomic temp+rename` on a single filesystem is durable under `EACCES`
and `ENOSPC` — the partial temp file fails to rename and is unlinked
in the catch path, leaving the original intact. A truly disk-full
filesystem may fail to write even the temp; the command exits non-zero
with the underlying errno and the operator sees that no backup was
created.

**Backup-sibling retention.** `gan hooks migrate` never garbage-collects
its own `.gan-bak.*` siblings — they are operator-owned artefacts. The
status command (`gan hooks status`) surfaces a one-line note when one
or more backup siblings are present in `<project>/.claude/hooks/`
("Backup siblings present from prior migrate operations: N files. Delete
manually when no longer needed."). Cleanup is the operator's
responsibility; the framework never deletes a backup it wrote.

**Confirmation prompt.** Each destructive action (`--delete`,
`--replace`) requires explicit confirmation. The default is interactive:
the command prints the action it is about to take and the backup path
it will create, then reads `y` / `N` from stdin (default `N` on bare
Enter). `--yes` skips the prompt. On a **non-TTY stdin** (CI, scripted
invocation), the prompt cannot run, so the command **fails closed**:
without `--yes` it exits non-zero with a structured error
`subReason: 'confirmationRequired'` and a message naming `--yes` as the
escape. `--review` is a pure read and is exempt from the prompt and
from `--yes`.

**Template resolution at runtime.** `--replace` needs the framework's
current template. At runtime the CLI is the installed
`@claudeagents/config-server` package, not the source checkout — the
template path is resolved by the existing `packageRoot()` helper
(`src/config-server/package-root.ts`), the same resolver
`src/cli/commands/hooks/status.ts` already uses (with the
`GAN_PACKAGE_ROOT_OVERRIDE` env-var hatch for test fixtures). The
template lives at `<packageRoot>/scripts/hooks/gan-confine.sh.template`
in the published package; the `__GAN_FRAMEWORK_VERSION__` placeholder is
substituted with the version read from `<packageRoot>/package.json` —
the same source `install.sh`'s `read_mcp_server_version` uses, never a
hardcoded constant — before the substituted content is written to the
project-tier hook path. Test fixtures override the resolution via
`GAN_PACKAGE_ROOT_OVERRIDE`.

### 3. Skill-side preflight diagnostic

`/gan` gains a pre-spawn check that runs *after* `validateAll()` and
*before* the clarifier spawn in step 8 of the Regular invocation flow.
The check synthesises the same behaviour probe `gan hooks status` uses,
runs it against any project-tier hook the orchestrator detects in the
target project's `.claude/hooks/`, and:

- Allows the run to proceed when the probe passes (the project-tier hook
  honours `$GAN_RUN_DIR`).
- Allows the run to proceed when no project-tier hook is detected (the
  user-tier hook applies, which the framework guarantees is current).
- **Halts the run** with a structured diagnostic when the probe fails.
  The diagnostic carries the `ConfigApiUnreachable`-shaped envelope (a
  literal `code` field, a `subReason` discriminator, and a human-readable
  `message` field) so log readers and telemetry can tell this halt
  apart from the loop-detection halts. The `subReason` discriminator
  takes one of two values: `noGanRunDirAwareness` when the probe ran
  the hook to completion and the hook returned non-zero on the
  `$GAN_RUN_DIR` write (the genuine stale-contract case), or
  `projectHookMisconfigured` when the candidate hook is not a runnable
  bash script (no valid shebang, not executable, or `spawn` failed
  before the hook could read stdin — the project-misconfiguration
  case the "Non-bash project-tier hook files" risk note covers). Both
  branches halt the run; the discriminator is what lets log readers
  and operators tell the two cases apart:

  ```json
  {
    "code": "StaleProjectConfinementHook",
    "subReason": "noGanRunDirAwareness",
    "message": "The project-tier confinement hook at `<path>` does not honour `$GAN_RUN_DIR`. A `/gan` sprint would fail mid-attempt when an agent writes to the central-store run directory. Run `gan hooks status` for details and `gan hooks migrate` to resolve."
  }
  ```

  ```json
  {
    "code": "StaleProjectConfinementHook",
    "subReason": "projectHookMisconfigured",
    "message": "The project-tier confinement hook at `<path>` is not a runnable bash script (no valid shebang, not executable, or otherwise unstartable). A `/gan` sprint cannot proceed until the file is fixed or removed. Run `gan hooks status` for details."
  }
  ```

  The halt happens *before* the run lock is acquired (per the
  bare-invocation precedent: no run state is created when the run cannot
  proceed). The user sees one clear message and a single command to run,
  rather than a cryptic mid-sprint denial 90 seconds in.

**Skill-to-probe bridge: the `probeConfineHook` MCP tool.** The
skill-side preflight runs in markdown; the probe is TypeScript. The
bridge between the two is a new MCP tool exposed by the framework's
config server, registered alongside the existing `validateAll`,
`getResolvedConfig`, and `emitTraceEvent` tools the orchestrator
already invokes. The new tool is `probeConfineHook({ projectRoot })`
and returns a stable shape:

```typescript
type ProbeConfineHookResult = {
  projectTierHookPath: string | null;  // null when no file at <project>/.claude/hooks/gan-confine.sh
  verdict: 'current' | 'stale' | 'misconfigured' | null;  // null iff projectTierHookPath is null
  subReason: 'noGanRunDirAwareness' | 'projectHookMisconfigured' | null;
  backupSiblings: string[];  // discovered .gan-bak.* siblings in <project>/.claude/hooks/
};
```

Internally, the MCP tool wrapper calls the same `runConfineHookProbe()`
function `gan hooks status` calls — that single shared call site is
where acceptance criterion 8's "byte-identical" guarantee lives. The
wrapper does no probe logic itself; it only marshals
`{ projectRoot }` into the runner's input shape and the runner's
output into the result shape above. The orchestrator invokes the tool
between step 3 (`validateAll()`) and step 8 (clarifier spawn) of the
Regular invocation flow; on `verdict === 'stale'` or `verdict ===
'misconfigured'` it emits the `StaleProjectConfinementHook` diagnostic
and halts before lock acquisition. On `verdict === 'current'` or
`projectTierHookPath === null` it proceeds.

**Trace integration: the `preflightAbort` event class.** When the
preflight halts, the orchestrator emits a `preflightAbort` trace
event via `emitTraceEvent({ runDir, event })`. The event is a new
typed class following the same four-place pattern `validationAbort`
uses (see File-level scope for the file list). Event shape:

```typescript
export interface PreflightAbortEvent extends TraceEnvelope {
  eventType: 'preflightAbort';
  preflightStage: 'confineHook';  // discriminator — future preflights add values
  errorCode: string;       // 'StaleProjectConfinementHook'
  errorSubReason: string;  // 'noGanRunDirAwareness' | 'projectHookMisconfigured'
  errorMessage: string;
  projectTierHookPath: string;
}
```

The orchestrator obtains the event body via a pure
`buildPreflightAbortBody({ stage, error, hookPath })` builder
(mirroring `buildValidationAbortBody`) and appends it with
`emitTraceEvent`.

**Just-in-time trace directory.** The trace library's
`appendTraceEvent` already creates the trace directory tree on first
write (it does not require a pre-existing `runDir`). The orchestrator
therefore derives the would-be `<runDir>` path via the standard
`resolveRunStore` mechanism (without acquiring the run lock or
calling `createRunWorkspace`), passes it as the event's `runDir`
argument, and the trace library creates `<runDir>/trace/` plus the
single event file. No new framework helper is required. The rest of
the run directory remains absent — no `progress.json`, no
`telemetry/`, no worktree. The run is **not recoverable** via
`--recover` because the lock was never acquired; the trace event is a
record-only telemetry surface for the operator's log readers.

The preflight is **not** bypassable by a flag in v1.0 of H3. The probe
is cheap (~10 ms; spawn one hook, deny one synthetic path) and the
failure mode it catches is destructive enough that masking it with a
flag would betray the H1 contract H3 is meant to repair. A v1.1 follow-
up may add `--ignore-stale-hook` for CI environments that deliberately
pin to a pre-F7 hook for compatibility testing — out of scope here.

### Composition with H1

**Authorised immutability exception.** PROJECT_CONTEXT § Conventions
("Implemented specs are immutable") forbids edits to a shipped spec.
H3 authorises **one bounded exception**: a single forward-reference
paragraph appended at the end of H1's "Migration from project-tier
installs" section, naming H3 by spec id and pointing operators at
`gan hooks status` and `gan hooks migrate`. **No other change to H1's
body is permitted under this exception** — no rewording, no heading
edits, no removal, no insertions outside the named anchor. Any edit
outside that boundary is a defect the reviewer must reject.

H1 governs *what the user-tier hook is* and *who owns the project-tier
file*. H3 governs *how the framework detects and migrates a project-
tier file that has drifted from the current contract*. H3 introduces
no new ownership claim and no new filesystem contract — it only adds
operator tools to verify project-tier hooks still satisfy the F7
contract and to bring them into line when they do not. Neither spec
retires the other.

## Acceptance criteria

1. **`gan hooks status` ships as an R3 subcommand.** The command lists
   the user-tier hook path, framework-version banner, contract revision,
   and Claude Code registration status; lists any project-tier hook and
   the same fields; and prints a remediation hint when the project-tier
   hook is detected as stale.
2. **The behaviour probe correctly classifies hooks.** A test suite
   under `tests/installer/` (alongside the existing
   `confineHook.behavioral.test.ts`) exercises the probe against (a) the
   framework's current template, (b) a pre-F7 hook with no
   `GAN_RUN_DIR` awareness, (c) a hand-written hook that allows
   everything, and (d) a non-bash file at the hook path (binary
   contents, no valid shebang). The probe verdicts are `current` /
   `stale` / `current` / `misconfigured` respectively. The same test
   suite asserts the probe's `mkdtempSync` temp tree is removed after
   each classification path.
3. **`gan hooks migrate --delete` removes the project-tier hook
   atomically.** Before the unlink, the prior content is copied to a
   timestamped backup sibling (`gan-confine.sh.gan-bak.<utc-iso-
   timestamp>`) via atomic temp+rename; only after the backup rename
   succeeds is the original path unlinked. The backup path is printed
   to stdout so the operator has the manual rollback command in hand
   (`mv` the backup back over the original). Tested by
   `tests/installer/confineHookMigrate.test.ts` — including a fault-
   injection case that confirms a failed backup write leaves the
   original file untouched.
4. **`gan hooks migrate --replace` overwrites the project-tier hook
   with the framework's current template.** The replacement is written
   via atomic temp+rename after the prior content is backed up to the
   same timestamped `gan-confine.sh.gan-bak.<timestamp>` sibling. The
   replacement carries the framework's version banner (the
   `__GAN_FRAMEWORK_VERSION__` placeholder substituted from
   `<packageRoot>/package.json`). Backup path printed to stdout.
   Tested under the same file.
5. **`gan hooks migrate --review` prints the diff and exits 0
   without writing.** No backup is created (pure read). Tested.
6. **`--yes` / non-TTY behavior.** `migrate --delete` and `migrate
   --replace` require either an interactive `y` confirmation (TTY
   stdin, bare-Enter defaults to `N`) or an explicit `--yes` flag.
   On non-TTY stdin without `--yes`, both subcommands fail closed:
   exit with the R3 `2` validation-failure mapping (same as
   `status` on stale/misconfigured) and emit a structured error
   `subReason: 'confirmationRequired'` with a message naming `--yes`
   as the escape. `--review` is exempt from both the prompt and from
   `--yes`. Tested for all three actions, with a TTY-emulation
   fixture covering the interactive `y` / `N` branches and a non-TTY
   fixture covering the fail-closed branch.
7. **The `/gan` skill-side preflight halts the run when the probe
   refuses.** A test under `tests/skills/` synthesises a project tree
   with a stale hook, invokes the skill, and asserts that no run
   state is created, no sub-agent spawns, and the structured
   `StaleProjectConfinementHook` diagnostic is emitted with the
   documented envelope shape and `subReason: "noGanRunDirAwareness"`.
   A second test case synthesises a non-bash file at the hook path,
   invokes the skill, and asserts the same envelope is emitted with
   `subReason: "projectHookMisconfigured"`. Both branches halt the run
   before lock acquisition.
8. **The skill-side preflight is byte-identical with the
   `gan hooks status` probe.** Both surfaces share one probe-runner
   helper (`src/cli/lib/confine-hook-probe.ts`) so a future
   framework-contract change updates one location.
9. **Documentation updated.** H1's spec gains a forward-reference
   paragraph appended at the end of its "Migration from project-tier
   installs" section; CLAUDE.md's "Confinement" section gains one
   sentence pointing operators at `gan hooks status`; and
   `specifications/roadmap.md` gains an H3 entry born in shipped form
   under the H phase, after H2's entry. Draft prose for each (the
   implementer may tighten wording but the substance is locked):

   - **H1 forward-reference paragraph** (appended verbatim, no other
     edits to H1's body under the immutability exception above):

     > **Forward reference (added by H3).** The detection and
     > migration tooling H1 anticipated is shipped in H3: run
     > `gan hooks status` to diagnose a stale or misconfigured
     > project-tier hook, and `gan hooks migrate --delete |
     > --replace | --review` to resolve it. See
     > `specifications/H3-stale-project-hook-detection-and-migration.md`.

   - **CLAUDE.md sentence** (appended to the existing "Confinement"
     notes; if no "Confinement" subsection exists, add a one-line
     subsection rather than scattering the note):

     > If a `/gan` sprint aborts mid-attempt with a confinement-denial
     > message, run `gan hooks status` to diagnose whether a stale
     > project-tier hook is the cause and `gan hooks migrate` to
     > resolve it.

   - **Roadmap entry** (placed after H2's entry under the H phase, in
     shipped form per the same-diff rule):

     > `✅ **[H3](H3-stale-project-hook-detection-and-migration.md)** —
     > Stale project-tier confinement hook detection and migration.
     > Shipped PR #<n>. Addresses the migration gap H1 flagged
     > abstractly and F7 made concrete.`

   The PR number is filled in by the human committer before merge.

## Non-goals

- **No automated overwrite of project-tier hooks at install time.** The
  user-tier hook is the framework's responsibility (per H1); the
  project-tier hook is the project's content. `install.sh` continues to
  leave project-tier hooks untouched. H3's migration is an explicit
  operator action via `gan hooks migrate`, never implicit during
  `install.sh`.
- **No removal of the project-tier override mechanism.** Projects with
  legitimate policy needs (CI compatibility, narrower restrictions for
  security-sensitive paths, wider restrictions for project-specific
  build caches) keep the project-tier override path. H3 only adds
  detection and migration tooling for the case where the project-tier
  copy has drifted *unintentionally*.
- **No support for project-tier hooks that are stale in a way the probe
  cannot detect.** The probe checks `$GAN_RUN_DIR` awareness via a
  synthesised write to a path inside `$GAN_RUN_DIR`. A hypothetical
  future contract change that did not surface as an allow/deny verdict
  on a write would require a different probe; out of scope here.
- **No bypass flag for the skill-side preflight in v1.0.** A
  hypothetical `--ignore-stale-hook` is explicitly out of scope and
  deferred to a v1.1 follow-up.

## File-level scope

**New files:**

- `src/cli/commands/hooks/status.ts` — new R3 subcommand.
- `src/cli/commands/hooks/migrate.ts` — new R3 subcommand.
- `src/cli/lib/confine-hook-probe.ts` — shared probe-runner helper
  (the `runConfineHookProbe()` function both surfaces invoke).
- `src/cli/lib/confine-hook-banner.ts` — version-banner parser shared
  between status, migrate, and install.
- `src/config-server/tools/confine-hook-probe.ts` — MCP tool wrapper
  `probeConfineHook({ projectRoot })` that exposes the probe runner
  to the skill-side preflight.
- `tests/installer/confineHookProbe.test.ts` — probe runner tests
  (classification + filesystem hygiene + allow-list pin).
- `tests/installer/confineHookMigrate.test.ts` — migrate tests
  (`--delete`, `--replace`, `--review`, backup-sibling pattern,
  `--yes`/non-TTY behavior, absent-project-hook edge cases).
- `tests/config-server/tools/confine-hook-probe.test.ts` — MCP tool
  wrapper test (marshalling + byte-identical-with-status assertion).
- `tests/skills/skill-stale-hook-preflight.test.ts` — skill-side
  preflight test (synthesises a stale-hook project tree, asserts
  the documented diagnostic envelope and `preflightAbort` trace
  event are emitted).

**Modified files:**

- `src/cli/index.ts` — wire the new `hooks` subcommand dispatch.
- `src/config-server/index.ts` — register the new MCP tools
  `probeConfineHook` and `buildPreflightAbortBody`.
- `src/trace/events.ts` — add the `PreflightAbortEvent` interface
  and the `'preflightAbort'` literal to the event-type union.
- `src/trace/integration.ts` — add the `buildPreflightAbortBody`
  pure builder, mirroring `buildValidationAbortBody`.
- `src/trace/index.ts` — re-export the new builder.
- `src/config-server/tools/trace.ts` — add the
  `buildPreflightAbortBodyTool` MCP wrapper.
- `skills/gan/SKILL.md` — add the preflight step between
  `validateAll()` and the clarifier spawn (step 8 of the Regular
  invocation flow).
- `specifications/H1-framework-owned-confinement-hook.md` — append
  the forward-reference paragraph (authorised by H3's immutability
  exception; bounded to a single paragraph at the end of "Migration
  from project-tier installs").
- `specifications/roadmap.md` — add the H3 entry, born in shipped
  form under the H phase, after H2's entry.
- `CLAUDE.md` (in this framework repo) — append the confinement-note
  sentence pointing operators at `gan hooks status` when they see a
  mid-sprint confinement denial.

**Out of scope:**

- `scripts/hooks/gan-confine.sh.template` — template content
  unchanged.
- `install.sh` — install flow unchanged. No new install-time prompts,
  no new install-time writes to project-tier paths.
- No new file under `schemas/`. MCP tool I/O shapes are defined
  inline in their tool wrappers, per existing convention.

## Risks and decisions to make during implementation

- **Probe filesystem hygiene.** The behaviour probe synthesises a temp
  directory tree for `$GAN_WORKTREE` and `$GAN_RUN_DIR` and feeds the
  hook a stdin payload. The probe must not leave debris on the
  operator's disk. The implementation uses `fs.mkdtempSync(os.tmpdir())`
  and a `try/finally` `rm -rf` of the temp tree on every code path. The
  temp prefix the probe passes to `mkdtempSync` includes the current
  process id (e.g. `gan-confine-probe-<pid>-`) so that parallel test
  workers — or parallel `gan hooks status` invocations from CI — do
  not collide on a shared prefix, and tests that count probe-prefixed
  temp dirs to assert hygiene cannot race against a sibling worker's
  in-flight probe.
- **Probe environment hermeticity.** The probe spawns the candidate
  hook with an **explicitly constructed** environment, not via
  inherit-and-augment. The env carries exactly five entries: `PATH`
  set to the POSIX-minimal `/usr/bin:/bin` (sufficient for the
  standard shell utilities a confinement hook may invoke — `jq`,
  `dirname`, `grep`, `cat` — but insufficient for operator-installed
  tooling that should not influence a hermetic probe); `GAN_RUN_ID`
  set to a known-good run-id grammar; `GAN_WORKTREE` and
  `GAN_RUN_DIR` set to the synthesised temp directories; and
  `CLAUDE_PROJECT_DIR` set to the synthesised `$GAN_WORKTREE` path
  (the Claude Code variable some hooks read for relative-path
  resolution). `HOME`, `USER`, `SHELL`, and every other ambient
  operator-env value are not forwarded — they would let a hook's
  behaviour depend on the operator's machine state and make the
  probe's classification non-deterministic across operators. A hook
  that requires an inherited variable for legitimate reasons is, by
  construction, outside the framework's contract and the probe
  correctly classifies it as `stale`.
- **Probe-target allow-list pin.** The probe targets a path inside
  `$GAN_RUN_DIR` whose membership in the framework's current template's
  allow-list is asserted by `tests/installer/confineHookProbe.test.ts`.
  The test reads the rendered template and asserts the probe-target
  path matches one of its allow-list entries. If a future template
  edit removes the probe-target path from the allow-list, the unit
  test fails immediately rather than the probe silently misclassifying
  the framework's own template as `stale`. The probe target is
  documented in `src/cli/lib/confine-hook-probe.ts` with a one-line
  comment naming the allow-list entry it relies on.
- **Banner-heuristic confidence vs. behaviour-probe confidence.** When
  both heuristics fire (the hook has a banner AND the probe verdict
  agrees), the report is unambiguous. When they disagree — in *any*
  direction (banner says current and probe says stale; banner says
  `lags` and probe says current; banner says `ahead` and probe says
  stale) — the behaviour probe wins. The probe tests the observable
  contract the framework actually depends on; the banner is metadata.
  The disagreement case includes both verdicts in the report so the
  operator can see which heuristic to trust.
- **Probe stdin contract.** Claude Code's PreToolUse hook reads a JSON
  envelope on stdin. The probe synthesises this exact shape:

  ```json
  {
    "session_id": "<probe>",
    "hook_event_name": "PreToolUse",
    "tool_name": "Write",
    "tool_input": { "file_path": "<absolute path inside the synthetic $GAN_RUN_DIR>" }
  }
  ```

  The shape is pinned in `src/cli/lib/confine-hook-probe.ts` with an
  inline comment citing `docs.claude.com/en/docs/claude-code/hooks` and
  the date the shape was last verified against the docs. The
  `ensure-worktree-mcp.sh` script reads the same envelope (via `cat`
  on stdin) but does not carry a doc-version pin — H3 introduces the
  pin in `confine-hook-probe.ts` as the canonical reference. If Claude
  Code changes the envelope shape, the probe needs updating in
  lockstep; the test fixture at `tests/installer/confineHookProbe.test.ts`
  is the first surface to fail because the framework's current
  template parses the same shape.
- **Non-bash project-tier hook files.** A file present at
  `<project>/.claude/hooks/gan-confine.sh` that is not a bash script
  (a binary, a script with a non-bash shebang, an empty file, a
  symlink to a non-executable target) is a project misconfiguration,
  not a stale-contract case. The probe distinguishes the two: if the
  candidate hook is not executable, has no valid shebang, or fails to
  start (the spawn errors before the hook can read stdin), the report
  flags `misconfigured` rather than `stale`, and the remediation hint
  for that branch tells the operator to fix or remove the file rather
  than to migrate it. The skill-side preflight treats `misconfigured`
  the same as `stale` for run-blocking purposes (both refuse to
  proceed) but emits a distinct `subReason` in the diagnostic envelope
  (`projectHookMisconfigured` rather than `noGanRunDirAwareness`) so
  log readers can tell the two cases apart.
- **Skill-side preflight blocking-vs-warning posture.** v1.0 of H3 is
  blocking. A warning posture (let the operator decide) is rejected:
  a stale hook *does* break the run, not "might"; the failure is
  mid-sprint and leaves stranded state; and the warning's message
  would be identical to the blocking diagnostic's. Warning posture
  is postponed to v1.1 only if a CI use case emerges that needs it.

## Migration / rollout

- **No breaking change.** H3 only adds CLI subcommands, a skill
  preflight, and tests. Existing flows continue to work — a project
  with no project-tier hook is unaffected; a project with a current
  project-tier hook is unaffected; a project with a stale project-tier
  hook gets a clear remediation path instead of a cryptic mid-sprint
  failure.
- **Implementation order.** **Single sprint.** Splitting `status`
  from `migrate` would ship a stale-remediation hint that prescribes
  `gan hooks migrate --review` — a subcommand that does not yet exist
  and exits 64 (unknown subcommand). The surfaces are too tightly
  coupled to ship separately. The single sprint lands, in one diff:
  - the shared probe runner `src/cli/lib/confine-hook-probe.ts`,
  - the banner parser `src/cli/lib/confine-hook-banner.ts`,
  - both `gan hooks` subcommands (`status` and `migrate` with all
    three actions `--delete`, `--replace`, `--review`),
  - the new MCP tool `probeConfineHook` in
    `src/config-server/tools/confine-hook-probe.ts` plus its
    registration in `src/config-server/index.ts`,
  - the new `preflightAbort` trace event class — the
    `PreflightAbortEvent` interface and union-member in
    `src/trace/events.ts`, the `buildPreflightAbortBody` builder in
    `src/trace/integration.ts`, the MCP tool wrapper in
    `src/config-server/tools/trace.ts`, and its registration in
    `src/config-server/index.ts`,
  - the skill-side preflight step in `skills/gan/SKILL.md`,
  - the H1 forward-reference paragraph (authorised by H3's
    immutability exception), the CLAUDE.md confinement-section
    sentence,
  - the `specifications/roadmap.md` H3 entry, born in shipped form
    (see acceptance criterion 9 for the verbatim entry).
