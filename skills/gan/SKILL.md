# GAN — Adversarial Development Loop

Run a full generative-adversarial development process: planner → contract negotiation → generator ↔ evaluator attempt loop, across all sprints.

## Invocation

```
/gan "build a CLI todo app"
/gan --spec ./SPEC.md "description"
/gan --specs ./specs/
/gan --target ~/projects/myapp "add dark mode"
/gan --max-attempts 3 --threshold 8 "build a REST API"
/gan --base-branch main --target ~/projects/myapp "refactor auth"
/gan --branch-name feature/payments --target ~/projects/myapp "add Stripe"
```

## Argument parsing

Parse these flags from the user's message before doing anything else:

| Flag | Default | Meaning |
|---|---|---|
| `--spec <path>` | none | Pre-written spec file. Skips the planner. |
| `--specs <dir>` | none | Directory of per-feature spec files. Planner assembles them. |
| `--target <path>` | none | Existing codebase path. Passes `TARGET_DIR:` to planner, proposer, and generator. |
| `--max-attempts <n>` | 3 | Max total attempts per sprint (including the first). After attempt `n` fails, the sprint is failed. |
| `--threshold <n>` | 7 | Default per-criterion threshold on a 1–10 scale. Passed to the proposer, which stamps it on every criterion. |
| `--max-attempts-total <n>` | 15 | Abort the whole run if cumulative generator invocations across all sprints hit this. |
| `--max-minutes <n>` | 60 | Orchestrator wall-clock budget. Abort cleanly when exceeded. |
| `--label <string>` | none | Free-form tag recorded in telemetry. Use this to group A/B runs (e.g. `generator-opus`, `eval-sonnet`). |
| `--telemetry-dir <path>` | `$GAN_TELEMETRY_DIR` or `$HOME/.gan-telemetry` | Where to persist config + outcomes. See [Telemetry](#telemetry). |
| `--base-branch <name>` | `develop` | Branch to base the run worktree on. Must exist in the repo before running. |
| `--branch-name <name>` | `gan/<run-id>` | Name for the single branch that accumulates all sprint commits. |
| `--no-telemetry` | false | Disable telemetry capture entirely for this run. |

The remaining text after flags is the user prompt passed to the planner.

---

## State directory

All state lives in `.gan/` in the current working directory (never inside `TARGET_DIR`). Create it if it does not exist.

### progress.json schema
```json
{
  "status": "planning | negotiating | building | evaluating | complete | failed",
  "currentSprint": 0,
  "totalSprints": 0,
  "completedSprints": 0,
  "currentAttempt": 0,
  "attemptsTotal": 0,
  "startedAt": "<ISO timestamp>",
  "startingBranch": "<branch name or null>",
  "failureReason": null
}
```

### File naming
- Spec: `.gan/spec.md`
- Contract draft: `.gan/sprint-{N}-contract-draft.json`
- Review verdict: `.gan/sprint-{N}-review.json`
- Final contract: `.gan/sprint-{N}-contract.json`
- Generator objection: `.gan/sprint-{N}-objection-{A}.json`
- Eval feedback: `.gan/sprint-{N}-feedback-{A}.json` (A is 1-based: 1, 2, …, `maxAttempts`)
- Worktree root: `.gan/worktree/` (single worktree for the entire run)
- Sprint base commit: `.gan/sprint-{N}-base-commit.txt` (SHA recorded before generator runs)
- PID tracking (evaluator): `.gan/eval-pids.txt`

### Single writer rule

**Only the orchestrator (this skill) writes `progress.json`.** Sub-agents may read it. They communicate state transitions by printing status lines to stdout; the orchestrator parses those and updates `progress.json`. If you ever see an instruction telling a sub-agent to write `progress.json`, it is a bug — remove it.

---

## Execution flow

### Step 0 — Resume check

If `.gan/progress.json` exists and `status` is not `"complete"` or `"failed"`:

Ask the user: `Found an interrupted run at sprint {currentSprint}/{totalSprints} (status: {status}). Resume? [Y/n]`

- **No**: delete `.gan/` contents (preserve any `gan/sprint-*` git branches the user may want to inspect — those live in their target repo, not in `.gan/`) and start fresh.
- **Yes**: apply the state-machine table below.

| status on resume | action |
|---|---|
| `planning` | delete `.gan/spec.md`, restart Step 1 |
| `negotiating` | delete `.gan/sprint-{N}-contract-draft.json`, `.gan/sprint-{N}-contract.json`, and `.gan/sprint-{N}-review.json`; restart Step 2a |
| `building` | Reset the worktree to `.gan/sprint-{N}-base-commit.txt` (`git -C .gan/worktree reset --hard <SHA>`). Do NOT increment `currentAttempt`. Restart the same attempt. If `.gan/worktree/` is missing, recreate it from `progress.json.runBranch` (without `-b`). |
| `evaluating` | The worktree should still be present. If `.gan/sprint-{N}-feedback-{A}.json` already exists and validates, treat it as the verdict and proceed. Otherwise respawn the evaluator. |
| `complete` / `failed` | prompt the user; do not auto-resume. |

### Step 0.5 — TARGET_DIR preflight

If `--target` is supplied:
1. Verify the path exists and is a git repository (`git -C <path> rev-parse --git-dir`).
2. Verify the working tree is clean (`git -C <path> status --porcelain` returns empty). If dirty, abort with:
   `TARGET_DIR has uncommitted changes. Commit or stash before running /gan.`
3. Record the starting branch in `progress.json.startingBranch` via `git -C <path> rev-parse --abbrev-ref HEAD`, so resume can recover.

### Step 0.6 — Worktree setup

The orchestrator creates **one worktree for the entire run**. All sprints commit to the same branch sequentially, so each sprint sees the full output of all previous sprints. On a failed attempt, the generator resets back to the commit that existed before that attempt started.

**For TARGET_DIR mode:**
1. Verify the base branch exists: `git -C <TARGET_DIR> rev-parse --verify <base-branch>`. If missing, abort:
   `Base branch '<base-branch>' not found in <TARGET_DIR>. Create it or pass --base-branch <other>.`
2. Determine the run branch name: `--branch-name` if provided, otherwise `gan/<run-id>`.
3. Create the worktree:
   ```sh
   REPO_DIR="<TARGET_DIR>"
   WORKTREE_ABS="$(pwd)/.gan/worktree"
   BRANCH="<branch-name>"
   git -C "$REPO_DIR" worktree add "$WORKTREE_ABS" -b "$BRANCH" "<base-branch>"
   ```
4. Record `worktreePath`, `runBranch`, and `baseBranch` in `progress.json`.

**For greenfield mode (no `--target`):**
1. Create `app/` if it does not exist.
2. If `app/` is not a git repo, initialize it:
   ```sh
   git -C app init
   git -C app checkout -b <base-branch>
   git -C app commit --allow-empty -m "chore: initial commit"
   ```
3. Create the worktree from `app/` the same way as TARGET_DIR mode above.

**Resume:** If `.gan/worktree/` already exists as a valid worktree (check with `git -C <REPO_DIR> worktree list`), skip creation and reuse it. The branch already has the commits from completed sprints.

**Teardown:** The worktree filesystem (`.gan/worktree/`) is removed at the end of the run (success or failure) to keep `.gan/` clean. The branch (`<run-branch>`) is always kept for inspection and merging:
```sh
git -C "$REPO_DIR" worktree remove .gan/worktree --force 2>/dev/null || true
```

Pass `WORKTREE_PATH: <WORKTREE_ABS>` in every prompt to the generator and evaluator.

### Step 0.75 — Telemetry init

Unless `--no-telemetry` is set:

1. Resolve telemetry dir: `--telemetry-dir` > `$GAN_TELEMETRY_DIR` > `$HOME/.gan-telemetry`.
2. Generate a run id: `<YYYYMMDDTHHMMSS>-<4 hex>` (e.g. `20260417T184210-a9f2`). Use `date -u +%Y%m%dT%H%M%SZ` and `openssl rand -hex 2` (or any 4-hex fallback).
3. Create `<telemetry-dir>/runs/<run-id>/` and write `config.json` there:

```json
{
  "runId": "20260417T184210-a9f2",
  "startedAt": "2026-04-17T18:42:10Z",
  "label": "<--label value or null>",
  "cwd": "<pwd at invocation>",
  "flags": {
    "spec": null, "specs": null, "target": "<path or null>",
    "maxAttempts": 3, "threshold": 7,
    "maxAttemptsTotal": 15, "maxMinutes": 60
  },
  "userPrompt": "<first 500 chars of the user's prompt>",
  "models": {
    "planner": "<value of 'model:' in agents/gan-planner.md>",
    "proposer": "<...>",
    "reviewer": "<...>",
    "generator": "<...>",
    "evaluator": "<...>"
  },
  "hostInfo": {
    "os": "<output of uname -s>",
    "arch": "<output of uname -m>"
  }
}
```

Read each agent's `model:` frontmatter from `$HOME/.claude/agents/gan-*.md` (follow symlinks). If unreadable, record `null`.

Remember the `runId` and `telemetryDir` for later steps. Persist them in `progress.json` as `telemetry.runId` and `telemetry.dir` so resume preserves them.

### Step 1 — Planning phase

Initialize `progress.json` (orchestrator writes this, not the planner):

```json
{
  "status": "planning",
  "currentSprint": 0,
  "totalSprints": 0,
  "completedSprints": 0,
  "currentAttempt": 0,
  "attemptsTotal": 0,
  "startedAt": "<ISO now>",
  "startingBranch": null,
  "failureReason": null
}
```

Validate it against `schemas/progress.schema.json` (see Schema validation below).

**If `--spec` was provided:**
- Read the file and write its contents to `.gan/spec.md`
- Count `Sprint N` patterns to determine `totalSprints`
- Update `progress.json` with `totalSprints`
- Skip to Step 2

**If `--specs` was provided:**
- Spawn `gan-planner` agent with prompt: `SPECS_DIR: <path>\n<user prompt if any>`

**Otherwise:**
- Build planner prompt:
  - Base: the user's prompt text
  - If `--target` was provided, append: `TARGET_DIR: <path>`
- Spawn `gan-planner` agent with that prompt.

After the planner finishes, parse its `PLANNING COMPLETE: {N} sprints defined` line and update `progress.json.totalSprints`. If the line is missing, abort with `failureReason: "planner did not report sprint count"`.

---

### Step 2 — Sprint loop

For each sprint N from 1 to `totalSprints`:

**Skip if already completed:**
If `completedSprints >= N` in progress.json, log `Sprint {N}: already complete, skipping` and continue.

#### 2a — Contract negotiation (up to 2 rounds)

Update `progress.json`: `status: "negotiating"`, `currentSprint: N`, `currentAttempt: 0`.

Track a flag `blockingRoute` (have we already rerouted through blocking concerns this sprint?) and `objectionFiled` (has an objection already been filed this sprint?) — both start false at the beginning of sprint N.

**Round 1:**
1. Build proposer prompt:
   - Base: `Sprint {N}`
   - Append: `THRESHOLD: {threshold}` (from `--threshold`)
   - If `--target` was provided, append: `TARGET_DIR: <path>`
   - If arriving from Step 2b objection: append `OBJECTION: .gan/sprint-{N}-objection-{A}.json`
   - If arriving from Step 2b blocking concerns: append `BLOCKING: <concerns summary>` (JSON-escape as needed)
2. Spawn `gan-contract-proposer` with that prompt. Verify `.gan/sprint-{N}-contract-draft.json` exists and validates against `contract.schema.json`.
3. Spawn `gan-contract-reviewer`. Verify `.gan/sprint-{N}-review.json` exists and validates against `review.schema.json`.
4. Read the review verdict.

**If `verdict == "approved"`:**
- Copy `.gan/sprint-{N}-contract-draft.json` → `.gan/sprint-{N}-contract.json`
- Delete the draft. Proceed to 2b.

**If `verdict == "revise"`:**
- **Round 2:** spawn proposer again with `REVISION_NOTES: <review.notes>` appended to the Round 1 prompt. Verify a new draft is written and validates.
- Spawn reviewer again. Whatever verdict it returns is final:
  - If approved: copy draft → final contract, delete draft, proceed to 2b.
  - If still `revise`: copy the latest draft → final contract anyway, print `WARNING: reviewer still wanted revisions after 2 rounds — using latest draft as-is`, proceed to 2b. (Bounds negotiation; further cycles rarely improve outcomes.)

If `.gan/sprint-{N}-contract.json` is missing after this step, abort with `failureReason: "contract negotiation failed for sprint {N}"`.

#### 2b — Build/evaluate attempt loop

For `attempt` from 1 to `maxAttempts` (inclusive):

- Check global budgets **before** spawning the generator:
  - If `progress.attemptsTotal >= maxAttemptsTotal`, abort with `failureReason: "max-attempts-total reached"`.
  - If wall-clock since `progress.startedAt` >= `maxMinutes`, abort with `failureReason: "max-minutes exceeded"`.

**Build:**

Update `progress.json`: `status: "building"`, `currentAttempt: attempt`, `attemptsTotal: attemptsTotal + 1`.

If `attempt > 1` (retry): reset the worktree branch back to the sprint's base commit so the generator starts clean:
```sh
SPRINT_BASE=$(cat .gan/sprint-{N}-base-commit.txt)
git -C .gan/worktree reset --hard "$SPRINT_BASE"
```

If `attempt == 1`: record the current HEAD as the sprint's base commit:
```sh
git -C .gan/worktree rev-parse HEAD > .gan/sprint-{N}-base-commit.txt
```

Build generator prompt:
- Base: `Sprint {N}, attempt {attempt}`
- Append: `WORKTREE_PATH: <absolute .gan/worktree path>`
- If `--target` was provided, append: `TARGET_DIR: <path>` (for context — generator works in the worktree)

Spawn `gan-generator`.

**Objection check (before evaluating):**

If `.gan/sprint-{N}-objection-{attempt}.json` exists:
- Validate against `objection.schema.json`.
- If `objectionFiled` is false: set it true, decrement `attemptsTotal` (this attempt did no work), route back to Step 2a with `OBJECTION: .gan/sprint-{N}-objection-{attempt}.json`. Do NOT count this as an attempt against `maxAttempts`.
- If `objectionFiled` is already true: ignore the objection (budget exhausted). Proceed to evaluate whatever the generator produced. If the working branch has no new commits versus its starting point, mark this attempt failed and continue the outer loop.

**Evaluate:**

Update `progress.json`: `status: "evaluating"`.

Build evaluator prompt:
- Append: `WORKTREE_PATH: <absolute path to .gan/worktrees/sprint-{N}-attempt-{attempt}/>`
- If `--target` was provided, append: `TARGET_DIR: <path>` (for context)

Spawn `gan-evaluator`. Verify `.gan/sprint-{N}-feedback-{attempt}.json` exists and validates against `feedback.schema.json`.

**Check result:**

Read `passed` and `blockingConcerns` from the feedback file.

- **If `blockingConcerns` is non-empty:**
  - If `blockingRoute` is false: set it true, route back to Step 2a with `BLOCKING: <concerns summary>` in the proposer prompt. Do NOT count this as an attempt against `maxAttempts`.
  - If `blockingRoute` is already true: fall through to the normal pass/fail logic below (prevents oscillation).

- **If `passed: true` (and we didn't just reroute for blocking):**
  - Increment `completedSprints` in progress.json
  - Log: `✓ Sprint {N} PASSED on attempt {attempt}`
  - Delete `.gan/sprint-{N}-base-commit.txt` (no longer needed).
  - Delete `.gan/sprint-{N}-contract-draft.json` if any leftover exists.
  - Break attempt loop, continue to next sprint (generator commits remain on the branch).

- **If `passed: false` and `attempt < maxAttempts`:**
  - Log: `✗ Sprint {N} failed attempt {attempt}, retrying...`
  - Continue attempt loop.

- **If `passed: false` and `attempt == maxAttempts`:**
  - Reset the worktree back to the sprint base commit (leave the branch clean at the last passing state):
    ```sh
    git -C .gan/worktree reset --hard "$(cat .gan/sprint-{N}-base-commit.txt)"
    ```
  - Update `progress.json`: `status: "failed"`, `failureReason: "sprint {N} failed max-attempts"`.
  - Log: `✗ Sprint {N} FAILED after {maxAttempts} attempts — stopping`
  - Run worktree teardown (Step 0.6) and telemetry finalize (see [Telemetry](#telemetry)).
  - Print summary table (see Step 3). Stop the entire harness. Do not continue to further sprints.

**Failure-path telemetry:** any abort earlier in the flow (planner didn't report sprint count, contract negotiation failed, schema validation failed, budget cap reached) must also run the telemetry finalize step before exiting. Telemetry captures failed runs; they're the most informative ones for A/B comparisons.

---

### Step 3 — Completion

Update `progress.json`: `status: "complete"` (only if all sprints passed).

Print a summary table:

```
════════════════════════════════════════
  GAN HARNESS COMPLETE
════════════════════════════════════════
  Sprint 1: ✓ PASS (1 attempt)
  Sprint 2: ✓ PASS (2 attempts)
  Sprint 3: ✗ FAIL (3 attempts)
────────────────────────────────────────
  Result: 2/3 sprints passed
  Total generator runs: {attemptsTotal}
  Wall clock: {minutes}m
════════════════════════════════════════
```

Run worktree teardown (Step 0.6) then print the branch for review:

```
Branch ready for review: gan/<run-id>  (based on develop)

Inspect, then merge or squash into develop when satisfied:
  git checkout develop
  git merge --no-ff gan/<run-id>
```

Finally, run the telemetry finalize step (below) before exiting.

---

## Telemetry

Purpose: keep a durable, cross-project record of every `/gan` run and its outcome, so runs can be compared (A/B model configs, prompt variations) even after the project directory is deleted or its `.gan/` wiped.

### Layout

```
<telemetry-dir>/
  runs.jsonl                    # append-only summary; one row per ended run
  runs/<run-id>/
    config.json                 # written at Step 0.75
    summary.json                # written at finalize; same as the jsonl row
    state/                      # snapshot of the project's .gan/ at end
      progress.json
      spec.md
      sprint-*-contract.json
      sprint-*-review.json
      sprint-*-feedback-*.json
      sprint-*-objection-*.json
```

`runs.jsonl` rows conform to `schemas/telemetry-summary.schema.json`:

```json
{
  "runId": "20260417T184210-a9f2",
  "label": "generator-opus-eval-sonnet",
  "startedAt": "2026-04-17T18:42:10Z",
  "endedAt": "2026-04-17T19:08:41Z",
  "durationSeconds": 1591,
  "status": "complete",
  "failureReason": null,
  "totalSprints": 4,
  "completedSprints": 4,
  "attemptsTotal": 7,
  "objectionsTotal": 1,
  "blockingConcernsTotal": 0,
  "sprintResults": [
    { "sprint": 1, "passed": true, "attempts": 1, "firstAttemptScoreMean": 8.2 },
    { "sprint": 2, "passed": true, "attempts": 2, "firstAttemptScoreMean": 6.1 }
  ],
  "models": {
    "planner": "opus", "proposer": "opus", "reviewer": "opus",
    "generator": "sonnet", "evaluator": "opus"
  },
  "flags": { "maxAttempts": 3, "threshold": 7, "maxAttemptsTotal": 15, "maxMinutes": 60 },
  "target": null
}
```

### Finalize step (invoke before any exit path — success OR failure)

1. Compute end metrics:
   - `endedAt`: ISO timestamp now.
   - `durationSeconds`: diff from `startedAt`.
   - `status`: value from `progress.status`.
   - `failureReason`: from `progress.failureReason`.
   - `objectionsTotal`: count of `.gan/sprint-*-objection-*.json` files.
   - `blockingConcernsTotal`: sum of `blockingConcerns.length` across all feedback files.
   - `sprintResults[]`: for each sprint N in 1..`totalSprints`:
     - `passed`: true iff the highest-attempt feedback has `passed: true`.
     - `attempts`: number of `sprint-N-feedback-*.json` files.
     - `firstAttemptScoreMean`: mean of `feedback[].score` in `sprint-N-feedback-1.json` (null if missing).
2. Snapshot: copy every file under `.gan/` into `<telemetry-dir>/runs/<run-id>/state/` (use `cp -a .gan/. <target>/state/`).
3. Write `<telemetry-dir>/runs/<run-id>/summary.json` with the full row.
4. Atomically append the row to `<telemetry-dir>/runs.jsonl` as a single `\n`-terminated line. Use `flock <telemetry-dir>/runs.jsonl.lock -c '...'` or write to `runs.jsonl.tmp.<run-id>` then `cat >> runs.jsonl` — never do naive `>>` from multiple simultaneous runs.
5. If `--no-telemetry` was set, skip all of the above.

**Never** put telemetry inside the project directory, `.gan/`, or `TARGET_DIR`. If `<telemetry-dir>` is somehow a subpath of the current cwd, warn and skip — this exists to survive project deletion.

### Resume and telemetry

On resume, reuse the `runId` stored in `progress.telemetry.runId`. Do NOT create a new telemetry directory — append to the existing run's snapshot at finalize time. If that record is gone (user wiped the telemetry dir), start a fresh one and record `"resumedFrom": "<original-runId-if-known>"` in config.json.

### Analysis

`runs.jsonl` is one JSON object per line. A simple analysis pass:

```sh
jq -s '[ .[] | select(.label == "generator-opus-eval-sonnet") ] | {
  runs: length,
  passRate: ([.[] | select(.status == "complete")] | length) / length,
  meanAttempts: (map(.attemptsTotal) | add / length)
}' < ~/.gan-telemetry/runs.jsonl
```

Group by `.label` to A/B different model configurations across the same spec.

---

## Schema validation

After every sub-agent writes an artifact, validate it against the matching schema in `schemas/`. If validation fails, print the error and abort with `failureReason: "schema validation failed: <artifact>"`.

| Artifact | Schema |
|---|---|
| `.gan/progress.json` | `schemas/progress.schema.json` |
| `.gan/sprint-{N}-contract-draft.json`, `.gan/sprint-{N}-contract.json` | `schemas/contract.schema.json` |
| `.gan/sprint-{N}-review.json` | `schemas/review.schema.json` |
| `.gan/sprint-{N}-feedback-{A}.json` | `schemas/feedback.schema.json` |
| `.gan/sprint-{N}-objection-{A}.json` | `schemas/objection.schema.json` |

Prefer whichever validator is available on the host. Try in order:
1. `python3 -c 'import jsonschema'` — if importable, use `python3 -m jsonschema -i <data> <schema>`.
2. `npx --yes ajv-cli validate -s <schema> -d <data>`.
3. Fall back to a structural check in the orchestrator's own code (required keys, basic types) and warn the user that strict validation was skipped.

---

## Critical rules — do not deviate

1. **Never exceed `maxAttempts` per sprint or `maxAttemptsTotal` across the run.** When either cap is reached and the sprint still fails, stop immediately.
2. **Always read `progress.json` before spawning an agent.** State must be current before each agent call.
3. **Always verify state files exist AND pass schema validation** after each agent returns before proceeding. If a file is missing or malformed, log the error and stop.
4. **The orchestrator is the sole writer of `progress.json`.** Sub-agents may read it. They communicate via stdout status lines, never by writing progress.
5. **Do not modify code directly.** The orchestrator only reads state files and spawns agents. All code changes are made by the generator agent.
6. **Never push, force-delete branches, or `git reset --hard` the user's work.** Branch isolation (`gan/sprint-{N}-attempt-{A}`) is how the generator writes to `TARGET_DIR`; the orchestrator never touches the user's original branches.
