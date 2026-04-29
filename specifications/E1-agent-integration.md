# E1 — Agent integration with the Configuration API

## Problem

The Configuration API (F2) and its reference implementation (R1) replace direct file reading with named function calls. But the existing agents (`gan-planner`, `gan-contract-proposer`, `gan-contract-reviewer`, `gan-generator`, `gan-evaluator`, the recovery flow described in O2, and the `/gan` skill orchestrator in SKILL.md) were authored before the API existed. Their prompts encode file paths, YAML field names, merge logic, and per-stack tooling assumptions.

This spec defines how those prompts and the orchestrator are rewritten to consume the API. Without it, the API can ship perfectly and the agents will still be doing the wrong thing.

## Proposed change

A coordinated rewrite of every agent and the skill orchestrator so they consume framework configuration only through the API. The rewrite preserves agent *intent* (each agent's role in the sprint loop) while replacing every direct read/parse with an API consumption.

### Orchestrator (SKILL.md) responsibilities

The `/gan` skill is the entry point. Post-E1, its responsibilities are:

1. **Parse arguments.** Recognise the top-level flags defined across O1 (`--print-config`), O2 (`--recover`, `--list-recoverable`), F4 (`--no-project-commands`), and the `--help` flag introduced by this spec. Maintain a single flag table (per the roadmap rule).
2. **Short-circuit for `--help` (pre-validation).** `--help` runs *before* `validateAll()` so a user with a broken config can still discover how to inspect or recover it. Print the help text and exit; no validation, no worktree, no agents.
3. **Validate.** Call `validateAll()` (F2). For a regular run, structured failure aborts with the validation report — no worktree, no agents, no writes to zones 2 or 3. For the `--print-config`, `--recover`, and `--list-recoverable` short-circuits, validation is **non-aborting**: any structured errors are captured but the run proceeds to the inspection / recovery handler. This honours O1's fail-open contract for `--print-config` (partial resolved view + structured errors) and gives the recovery flow access to a known-broken project's run archive, which is exactly when the user needs it.
4. **Short-circuit for inspection / recovery flags.** For `--print-config`, call `getResolvedConfig()` and emit the result via O1's surface (resolved view if validation passed, or partial view + the captured error report if validation failed), then exit. For `--recover` / `--list-recoverable`, dispatch to the recovery flow (O2). No sprint work runs in any of these paths.
5. **Capture the snapshot.** For a regular invocation, after `validateAll()` succeeds call `getResolvedConfig()` once. The returned snapshot is the **single source of truth** for configuration during this run.
6. **Print the startup log.** Per O1's part A, emit one structured log line summarising the snapshot. **First-run nudge:** when the active stack set resolves to `stacks/generic.md` only (no real ecosystem stack matched), the startup log emits an additional non-suppressible line: `No recognised ecosystem stack — running with generic defaults. For richer behaviour, run \`gan stacks new <name>\` to scaffold a stack file, or fork an existing one from \`stacks/\` as a starting point.` The note appears even when log verbosity is reduced; it is part of the contract that the framework tells non-Node users *something* useful on first run. (A friendlier prose authoring guide is a known follow-up; today the canonical reference is C1's schema spec plus existing stack files.)
7. **Create the worktree.** Use `.gan-state/runs/<run-id>/worktree` per F1's zone 2; record the run's metadata in `.gan-state/runs/<run-id>/progress.json`.
8. **Run the sprint loop.** For each sprint: spawn `gan-contract-proposer`, `gan-generator`, `gan-evaluator` in sequence, passing the snapshot to each. Manage retry per the existing discriminator logic. On unrecoverable failure or completion, mark the run terminal and tear down the worktree.
9. **Surface errors.** Any API error during the run is reported to the user with `code`, `file`, `field`, and `message` from F2's structured error model intact.

The orchestrator does **not** parse stack files, overlay files, or YAML directly. Every read goes through the API.

Per-run state (`progress.json`, sprint contracts, evaluator feedback) is **not** Configuration API territory — it is run state, persisted directly under `.gan-state/runs/<run-id>/`. The API is for framework configuration; per-run state is for sprint orchestration. Distinct lanes.

### Shared agent-rewrite pattern

Every agent obeys these rules post-E1:

- **Snapshot consumption.** The orchestrator passes the snapshot from `getResolvedConfig()` to the agent at spawn time as part of its initial context. The snapshot's JSON shape is exactly what F2's `getResolvedConfig()` returns. The agent reads from the snapshot as if it were data, not configuration. It does not call `getResolvedConfig()` itself; this prevents per-agent re-validation and ensures every agent in a sprint sees identical config.
- **Snapshot freshness.** The snapshot is frozen for the entire `/gan` run across user-side edits: the orchestrator does not re-snapshot between sprints to catch user file edits (per F2). When any agent's API call returns `{ mutated: true, ... }` (per F2's mutation indicator), the orchestrator records this against the current sprint and **always** re-snapshots before spawning the next agent. Re-snapshot-after-true-mutation is unconditional; a write that returned `mutated: false` (e.g. duplicate-skip append) does not trigger re-snapshot. This makes downstream-agent visibility deterministic and avoids re-snapshotting on no-op writes.
- **Writes via API.** Agents never write config files directly. To update a stack, an overlay, or module state, the agent calls the corresponding API function and surfaces any returned structured error.
- **Error handling.** When any API call returns a structured error, the agent reports it as a blocking concern in its output, preserving the error's `code`, `file`, `field`, `line`, and `message` verbatim. The agent does not interpret, translate, or hide the error. Per F2's discipline rule, agents never reference maintainer-only scripts in user-visible output.
- **Confinement.** Existing confinement hooks (PreToolUse sandboxing to the worktree) remain in place. MCP tool calls are not file system reads and do not break confinement. Agents may call the API freely from inside a confined worktree.
- **Output discipline.** Agents emit user-facing output (status, errors, completions, structured artifacts the orchestrator collects). They do not emit MCP-server-internal details, raw API responses, or internal trace logs to the user.

### Per-agent rewrite checklists

For each agent: what it reads/writes today, and what replaces each in the rewrite. "Snapshot.X" means `<snapshot>.X` in the JSON returned by `getResolvedConfig()`.

#### gan-planner

| Currently | After E1 |
|---|---|
| Reads project files for context (free-form). | Receives the snapshot. Uses `snapshot.activeStacks` to know which technologies are involved. |
| Reads any project context embedded in agent prose. | Reads `snapshot.additionalContext.planner` — the resolved file contents (or "missing" markers) per U3. |
| Has a default threshold baked in. | Reads `snapshot.mergedSplicePoints["runner.thresholdOverride"]` for the criteria threshold. |
| (No writes today.) | (No writes.) |

The planner produces a sprint spec. Its output shape is unchanged by E1; its inputs are now structured.

#### gan-contract-proposer

| Currently | After E1 |
|---|---|
| Has a hardcoded checklist of ~10 generic security criteria. | Removes the checklist entirely. Sources every security criterion from `snapshot.activeStacks[*].securitySurfaces`, applying C1's template-instantiation protocol against the sprint's affected files (which the planner identified). |
| Has stack-specific assumptions in prose ("if Android, also check…"). | Removes all stack-specific prose. The active set drives behavior. |
| Fixed criterion thresholds. | Reads `snapshot.mergedSplicePoints["runner.thresholdOverride"]` as the default; per-criterion overrides come from `snapshot.mergedSplicePoints["proposer.additionalCriteria"]`. |
| (No writes.) | (No writes.) |

The proposer's output (the sprint contract) is unchanged in shape.

#### gan-contract-reviewer

| Currently | After E1 |
|---|---|
| Reads `.gan/progress.json`, `.gan/sprint-{N}-contract-draft.json`, `.gan/spec.md`, prior `.gan/sprint-{K}-contract.json` files directly. | Receives the snapshot. Reads the contract draft and prior contracts from `.gan-state/runs/<run-id>/` (run state, not Configuration API territory) per F1's zones. |
| Generic "criteria must be testable" prose. | Unchanged — the reviewer's audit semantics (specificity, comprehensiveness, scope) are independent of the Configuration API. |
| No project-level reviewer extension point. | Reads `snapshot.mergedSplicePoints["proposer.additionalCriteria"]` to recognise project-introduced criteria as legitimate (not "duplicating" if they came from the overlay). |
| Hardcoded knowledge of which file paths exist in the orchestration zone. | All paths come from the orchestrator's spawn context, which sources them from F1's zone 2 layout. |
| (No config writes.) | (No config writes; produces the verdict JSON the orchestrator consumes.) |

The reviewer's role in the contract-negotiation loop is unchanged: audit the proposed contract before the generator runs, return a verdict. E1 only retires the file-reading and the hardcoded path knowledge.

#### gan-generator

| Currently | After E1 |
|---|---|
| Reads code files in the worktree (its primary job). | Unchanged — file-system reads inside the worktree are the generator's normal work and not Configuration API territory. |
| Has hardcoded coding standards. | Reads `snapshot.mergedSplicePoints["generator.additionalRules"]` for project-specific rules in addition to its baked-in standards. |
| May invoke a build to verify (per stack hardcoding). | Reads `snapshot.activeStacks[*].buildCmd` for verification builds; falls back gracefully if the active stack provides no `buildCmd`. |
| (No config writes.) | (No config writes.) |

The generator may write code in the worktree (its job); that is not API territory.

#### gan-evaluator

| Currently | After E1 |
|---|---|
| Hardcoded secrets glob list. | Reads `snapshot.activeStacks[*].secretsGlob`, scoped per stack. |
| Hardcoded audit branch per stack (`npm audit`, `pip-audit`, etc.). | Reads `snapshot.activeStacks[*].auditCmd`, including its `absenceSignal` and `absenceMessage`. |
| Hardcoded test/lint per stack. | Reads `snapshot.activeStacks[*].testCmd` / `lintCmd`. |
| Hardcoded "run the app" via stack-specific commands. | Reads `snapshot.activeStacks[*].buildCmd` separately from test and lint. |
| No project-level evaluator extension point. | Runs `snapshot.mergedSplicePoints["evaluator.additionalChecks"]` after the stack's own commands. |
| Cross-contamination risk in polyglot repos. | Applies stack-scoped fields only to files inside that stack's `scope` per C2. |
| Monolithic prompt mixing deterministic decisions and LLM analysis. | **Carves out a deterministic core** at `src/agents/evaluator-core/` exposing pure functions that produce a structured evaluator plan from typed inputs (snapshot + sprint plan + worktree state). The LLM portion of the evaluator runs after the core, consuming its output. E3's harness exercises the core directly. |
| (No config writes.) | (No config writes; produces the feedback JSON the discriminator consumes.) |

#### gan-recover (the agent role described in O2)

| Currently | After E1 |
|---|---|
| Restores `.gan/` from an archive directory. | Restores from `.gan-state/runs/<run-id>/` (zone 2). Per F1, the per-run directory persists naturally; "recovery" becomes "re-attach worktree and resume Step 0," not "copy from archive to cwd." |
| Reads `progress.json` from the archive. | Reads `progress.json` directly from the run directory. (Not Configuration API territory — run state.) |
| No config validation before recovery. | Calls `validateAll()` first. Refuses to recover into an environment whose configuration is currently invalid. |
| Could touch any directory. | Forbidden from touching `.gan-state/modules/` (per F1's invariant; module state is not run state). |
| Implicit assumption that overlays didn't change. | Compares `getResolvedConfig().overlays` against the archived run's recorded overlay state (stored in `progress.json`). On a meaningful drift, surfaces a warning in the recovery report. |

The full reconception of O2 to fit F1 lives in O2's revision (which depends on this spec). E1 specifies the agent integration; O2's revision specifies the new mechanism using these integrations.

### Migration approach

**Single coordinated PR**, internally split into per-agent commits for review. Recommended commit order:

1. R1 in place (prerequisite — not E1's work, but E1 cannot land without it).
2. Orchestrator (SKILL.md) rewrite: validateAll → getResolvedConfig → snapshot → spawn. The evaluator-pipeline harness (E3) immediately starts being meaningful.
3. gan-evaluator rewrite (largest surface, highest test coverage in E3).
4. gan-contract-proposer rewrite (retires the hardcoded checklist).
5. gan-contract-reviewer rewrite (mechanically light; just removes file-system reads and routes through the snapshot).
6. gan-generator rewrite (smallest surface change).
7. gan-planner rewrite.
8. O2 revision lands separately afterwards (per its header note).

The evaluator-pipeline harness (E3) gates the PR: a passing evaluator-pipeline check means each agent's rewrite preserves behavior on every fixture.

Incremental landing is **not** recommended. A half-rewritten agent set leaves the framework in a state where some agents are reading files and others are reading the snapshot, with no guarantee they agree. The risk of subtle bugs outweighs the review-size benefit.

### Retirement of old artifacts

E1 is the cutover spec for the framework's agent layer. When E1 lands, every old artifact in this list must be retired in the same PR. The PR is incomplete if any survive. See the [roadmap's Retirement table](roadmap.md#retirement-table) for the full canonical list; this section names what E1 owns specifically.

**Rewritten in place (`M` entries in the PR diff — same path, full content replacement):**

- `agents/gan-planner.md`
- `agents/gan-contract-proposer.md`
- `agents/gan-contract-reviewer.md`
- `agents/gan-generator.md`
- `agents/gan-evaluator.md`
- `skills/gan/SKILL.md`

These six files survive at their existing paths but their old content goes away wholesale. After the PR lands, no piece of the old prompt structure should be reachable: not the `.gan/` file-read steps, not the hardcoded stack-specific tokens, not the bespoke validation flow inside the old SKILL.md. R4's `lint-no-stack-leak` (with agent prompts in scope per slice 4 of the third-pass response) is the permanent backstop catching ecosystem-token regressions in these files.

**Deleted (`D` entries in the PR diff — files go away entirely):**

- `skills/gan/gan` — broken symlink, dead artifact.
- `skills/gan/schemas/contract.schema.json`
- `skills/gan/schemas/feedback.schema.json`
- `skills/gan/schemas/objection.schema.json`
- `skills/gan/schemas/progress.schema.json`
- `skills/gan/schemas/review.schema.json`
- `skills/gan/schemas/telemetry-summary.schema.json`

The six `skills/gan/schemas/*.json` files describe per-run state inside the old orchestrator. The rewritten orchestrator either re-authors them under a new location consistent with F1's zones (e.g. `schemas/run-state/<type>-v1.json` per F3's naming) **or** drops them if the new flow no longer validates against the same shapes. The E1 PR must commit to one of the two paths and execute it; whichever is chosen, the originals are deleted at the old path. Leaving them at the old path implies the old SKILL.md is still loading them.

**Verification.** The PR reviewer cross-checks the diff against this list. Survivors block the merge until retirement is complete. After E1 lands, `find . -path '*/skills/gan/gan' -o -path '*/skills/gan/schemas/contract*'` and similar commands should produce empty output.

**Why this discipline.** Dead prompts are especially dangerous. LLM prompts compose by inclusion (a stale `agents/gan-planner.md` left in place may be picked up by Claude Code's agent discovery, by a `Read` tool invocation, by future authoring confusion, or by a search-and-paste in an unrelated PR). The framework cannot have two definitions of "what gan-planner does" in the working tree. Deletion / replacement is the only safe state.

## Acceptance criteria

- Each agent prompt (`gan-planner.md`, `gan-contract-proposer.md`, `gan-contract-reviewer.md`, `gan-generator.md`, `gan-evaluator.md`, plus the recovery agent role) contains zero direct file paths to configuration files, zero YAML field names that imply parsing, zero merge or cascade logic.
- `gan-evaluator.md` contains zero references to `kt`, `kts`, `gradle`, `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`, or any other tool-specific token. Same for every other agent prompt.
- `gan-contract-proposer.md` contains zero hardcoded security criteria; every criterion in its output traces to a `securitySurfaces` entry in an active stack or to a `proposer.additionalCriteria` overlay entry.
- The skill orchestrator's first action on a regular invocation is `validateAll()`. Verified by inspection of SKILL.md.
- The orchestrator captures the snapshot once via `getResolvedConfig()` and passes it to every spawned agent. No agent calls `getResolvedConfig()` itself.
- Every API error during agent work is reported as a blocking concern with the structured error fields (`code`, `file`, `field`, `message`) preserved verbatim.
- Capability tests (E3) pass for every fixture in `tests/fixtures/stacks/` against the rewritten agents.
- `/gan --print-config` emits the resolved config and exits without creating a worktree. **Validation failure does not abort `--print-config`**: the partial resolved view plus the captured structured errors are emitted together (O1's fail-open contract).
- `/gan --recover` (post O2 revision) restores a run, calling `validateAll()` in non-aborting mode (so a known-broken project's run archive is still recoverable), leaving `.gan-state/modules/` untouched.
- `/gan --help` (and `/gan -h`, `/gan help`) prints the help text and exits without calling `validateAll()`, without creating a worktree, and without spawning any agent. The help text lists every top-level flag (`--help`, `--print-config`, `--recover`, `--list-recoverable`, `--no-project-commands`) with one-line descriptions, points the user at the `gan` CLI for configuration management and at `.claude/gan/project.md` for overlay authoring, and includes at least one realistic invocation example. Help output never references maintainer-only scripts.
- The orchestrator only re-snapshots between sprints when a write in the prior sprint returned `{ mutated: true, ... }`. A write that returned `mutated: false` does not trigger re-snapshot. Verified by an integration test that runs a sprint pair where the first sprint's only API call is `appendToStackField(..., duplicatePolicy="skip")` against an entry already present, and asserts the second sprint sees the same snapshot identity.
- When the active stack set is `[generic]` only, the orchestrator's startup log includes the first-run nudge naming `gan stacks new`. Verified by a fixture test against `tests/fixtures/stacks/generic-fallback/`.

## Dependencies

- F1 (filesystem layout)
- F2 (API contract)
- R1 (the API the agents consume)
- C1, C2, C3, C4, C5 (data shapes the snapshot exposes)

E2 (stack extraction) and E3 (evaluator-pipeline harness) are companion specs in Phase 3 — E1's per-agent rewrites coordinate with E2's stack files at implementation time, and the rewrite's correctness is gated by E3's harness. None of those dependencies prevent E1 from being authored first; the spec text describes the rewrite pattern abstractly.

## Bite-size note

Per the migration approach: one coordinated PR, but each agent is its own sprint slice within it. Recommended slice sequence:

1. Orchestrator rewrite (~ one sprint).
2. gan-evaluator (~ one sprint; largest surface).
3. gan-contract-proposer (~ one sprint).
4. gan-generator (~ one sprint).
5. gan-planner (~ one sprint).

The full PR is then five sprint slices stitched together with evaluator-pipeline tests gating each merge. O2's revision is a separate sprint that follows.
