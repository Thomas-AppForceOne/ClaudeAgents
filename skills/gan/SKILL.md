# GAN — Adversarial Development Loop

Run a generative-adversarial development pipeline against a sprint plan: contract-proposer → generator → evaluator, looped per sprint. The orchestrator is a thin shell — every framework configuration value comes from the Configuration API. The orchestrator never parses stack files, overlay files, or YAML directly.

## Invocation

```
/gan "build a CLI todo app"
/gan --help
/gan --print-config
/gan --recover
/gan --list-recoverable
/gan --no-project-commands "review someone's branch"
```

## Argument parsing

Parse arguments from the user's message before doing anything else. The five flags below are mandatory in the new flag table; user-supplied flags such as `--spec`, `--target`, `--max-attempts`, `--threshold`, `--branch-name`, `--base-branch`, and `--label` continue to be honoured for sprint-shape control and telemetry.

| Flag | Default | Meaning |
|---|---|---|
| `--help` (also `-h`, `help`) | n/a | Print help text and exit 0. Runs BEFORE validation; no worktree, no agents. |
| `--print-config` | n/a | Inspection short-circuit. Calls validation in non-aborting mode, prints the resolved view (plus any structured errors), exits. No worktree, no agents. |
| `--recover` | n/a | Recovery short-circuit. Calls validation in non-aborting mode, dispatches to the recovery flow. No new worktree until recovery resumes. |
| `--list-recoverable` | n/a | Inventory short-circuit. Calls validation in non-aborting mode, prints recoverable runs, exits. |
| `--no-project-commands` | false | Skip every command sourced from `project` and `user` tier files for this run; falls back to `builtin` tier defaults (per F4). |

Help output never references maintainer-only scripts. Help text points the user at the `gan` CLI (for example `gan stacks new`, `gan trust info`, `gan config print`) for configuration management, and at `.claude/gan/project.md` for overlay authoring. Help includes at least one realistic invocation example.

The remaining text after flags is the user prompt passed to the planner (when a regular run is invoked).

## Help short-circuit

`--help` runs **before** `validateAll()`. The orchestrator prints the help text to stdout and exits 0. There is no validation, no snapshot, no worktree, and no agent is spawned. A user with a broken project configuration can still discover how to inspect or recover it without first fixing validation. This is the only flag that skips validation entirely.

## Inspection and recovery short-circuits

`--print-config`, `--recover`, and `--list-recoverable` call `validateAll()` in **non-aborting mode**: any structured errors are captured and surfaced alongside the partial resolved view (for `--print-config`) or in the recovery report (for `--recover` / `--list-recoverable`). The user can inspect a known-broken project's configuration or recover its run archive without first fixing validation — this is exactly when fail-open behaviour is most useful.

Specifics:

- `--print-config` calls `getResolvedConfig()` and emits an O1-shaped object on stdout. When validation captured errors, both the partial `resolvedConfig` and the `validationErrors` are emitted as top-level keys; exit code reflects validation status.
- `--recover` and `--list-recoverable` dispatch to the recovery flow (per O2's revision). Recovery refuses to touch `.gan-state/modules/` (zone-2 module-state ownership rule).

No sprint work runs in any of these paths.

## Regular invocation flow

The orchestrator follows this order on every regular `/gan` invocation:

1. **Parse args.** Build the flag table from the user's message.
2. **`validateAll()` (aborting).** This is the orchestrator's first action on a regular run. Failure aborts the run with the F2 structured error report — no worktree is created, no agent is spawned, and no zone-2 or zone-3 writes occur. The structured error fields (`code`, `file`, `field`, `line`, `message`) are surfaced verbatim. The user-facing remediation hint (when present) is forwarded as-is; the orchestrator does not paraphrase or interpret API errors.
3. **`getResolvedConfig()` — capture the snapshot once.** The returned snapshot is the **single source of truth** for this run. It is data, not configuration. The orchestrator passes it to every spawned agent.

   **Enrich the snapshot with active-stack bodies before spawn.** The F2 `ResolvedConfig` carries only metadata for each active stack — `{tier, path, schemaVersion}` — not the body fields the agents reference (`buildCmd`, `testCmd`, `lintCmd`, `auditCmd`, `secretsGlob`, `securitySurfaces`, `cacheEnv`, `scope`). After `getResolvedConfig()` returns, for each name in `snapshot.stacks.active`, call the API's `getStack(name)` to load the parsed body and attach those fields onto the matching `snapshot.stacks.byName[name]` entry. The result is the "enriched snapshot" — what every agent prompt means by `snapshot.activeStacks[*].buildCmd` etc. Without this enrichment step, agents see undefined per-stack commands and silently degrade to graceful-fallback paths even when the stack file declared the command. Re-enrichment is performed only when the snapshot is re-captured after a `mutated: true` API call (per the freshness rule below); idempotent re-runs against an unchanged snapshot reuse the enriched object.
4. **Print the startup log** (per O1 part A). One structured line summarising the active stacks, overlay sources, additionalContext paths, and discarded fields. Missing sources are listed explicitly; nothing is silently omitted.

   **First-run nudge.** When the active stack set resolves to `stacks/generic.md` only (no real ecosystem stack matched), the startup log emits an additional non-suppressible line. The verbatim text of the contract is reproduced here so the orchestrator can match the spec exactly:

   > 6. **Print the startup log.** Per O1's part A, emit one structured log line summarising the snapshot. **First-run nudge:** when the active stack set resolves to `stacks/generic.md` only (no real ecosystem stack matched), the startup log emits an additional non-suppressible line: `No recognised ecosystem stack — running with generic defaults. For richer behaviour, run \`gan stacks new <name>\` to scaffold a stack file, or fork an existing one from \`stacks/\` as a starting point.` The note appears even when log verbosity is reduced; it is part of the contract that the framework tells non-Node users *something* useful on first run. (A friendlier prose authoring guide is a known follow-up; today the canonical reference is C1's schema spec plus existing stack files.)

5. **Create the worktree.** Use `.gan-state/runs/<run-id>/worktree` per F1's zone 2. Record run metadata in `.gan-state/runs/<run-id>/progress.json`. The `<run-id>` follows the established `<YYYYMMDDTHHMMSS>-<4 hex>` form.
6. **Spawn the sprint loop.** For each sprint:
   - Pass the snapshot to `gan-contract-proposer` (proposes the sprint contract — every security criterion sourced from the active stacks' `securitySurfaces` per C1 template instantiation).
   - Pass the snapshot and the contract to `gan-generator`.
   - Pass the snapshot, the contract, and the worktree state to `gan-evaluator`.

   The orchestrator never re-parses configuration files between sprints; it always passes the captured snapshot.

7. **Tear down.** On completion or unrecoverable failure, mark the run terminal in `progress.json` and remove the worktree filesystem (the run branch survives for inspection).

## Snapshot freshness rule

The captured snapshot is **frozen across user-side edits** for the entire run, including across multiple sprints in a multi-sprint plan. Wall-clock time between sprints does not matter; user edits to overlay or stack files mid-run are not picked up until the next `/gan` invocation. This is a deliberate consistency choice — a contract issued in sprint N must remain meaningful when evaluated in sprint N+1.

When any agent's API call returns `{ mutated: true, ... }` (per F2's mutation indicator), the orchestrator records the per-sprint OR of every agent's `mutated` flag; if any agent in the prior sprint produced `mutated: true`, the orchestrator **always** re-snapshots via `getResolvedConfig()` before spawning the next agent. There is no "may" — re-snapshot-after-true-mutation is unconditional. A `mutated: false` result (e.g. duplicate-skip append) does **not** trigger a re-snapshot; durable state is unchanged so downstream-agent visibility remains the same.

## Per-run state versus configuration

Per-run state — `progress.json`, sprint contracts, evaluator feedback, generator artefacts — lives directly under `.gan-state/runs/<run-id>/` (zone 2). It is **not** Configuration API territory. The API is for framework configuration; per-run state is for sprint orchestration. Distinct lanes.

The orchestrator is the sole writer of `progress.json`. Sub-agents may read it but never write it; they communicate state transitions via stdout status lines that the orchestrator parses.

## Error surfacing

Every API error (during validation or during a sprint) is reported with the F2 structured fields preserved verbatim: `code`, `file`, `field`, `line`, `message`. The orchestrator does not interpret, translate, or summarise these. User-facing messages obey F4's discipline: shell remediation (`rm <path>`), references to "the framework" rather than specific runtimes, no maintainer-only script names, readable to a developer who has only run `install.sh`.

## Confinement

The existing PreToolUse hook remains in place. Spawned agents write only inside `.gan-state/runs/<run-id>/worktree` and to their designated artefact paths under `.gan-state/runs/<run-id>/`. MCP tool calls are not file-system reads; agents may call the API freely from inside a confined worktree.

## Trust integration

When the validation step returns the `UntrustedOverlay` structured error, the orchestrator surfaces the trust prompt described in F4 / R5. The user's choice is one of:

- **Approve and run** — record the new content hash via the API's `trustApprove` write.
- **Run with `--no-project-commands`** — set the runtime mode and continue without writing to the trust cache.
- **Cancel** — abort the run.

`GAN_TRUST=strict` makes the prompt fail closed in CI; `GAN_TRUST=unsafe-trust-all` skips the trust check entirely (logged loudly).

## Spawn discipline (summary)

Sub-agents are spawned only as part of the regular invocation flow. They are never spawned during a help short-circuit, a print-config short-circuit, or a recovery short-circuit. Each spawn receives the captured run context (worktree path, sprint number, attempt number, contract path) and the resolved configuration object.

The orchestrator parses the artefact each agent writes under `.gan-state/runs/<run-id>/` and decides whether to spawn the next agent.
