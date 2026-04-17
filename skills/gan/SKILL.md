# GAN — Adversarial Development Loop

Run a full generative-adversarial development process: planner → contract negotiation → generator ↔ evaluator retry loop, across all sprints.

## Invocation

```
/gan "build a CLI todo app"
/gan --spec ./SPEC.md "description"
/gan --specs ./specs/
/gan --target ~/projects/myapp "add dark mode"
/gan --max-retries 3 --threshold 8 "build a REST API"
```

## Argument parsing

Parse these flags from the user's message before doing anything else:

| Flag | Default | Meaning |
|---|---|---|
| `--spec <path>` | none | Pre-written spec file. Skips the planner. |
| `--specs <dir>` | none | Directory of per-feature spec files. Planner assembles them. |
| `--target <path>` | none | Existing codebase path. Passes `TARGET_DIR:` to planner and generator. |
| `--max-retries <n>` | 2 | Max generator retries per sprint before marking failed. |
| `--threshold <n>` | 7 | Minimum score per criterion to pass (1-10). |

The remaining text after flags is the user prompt passed to the planner.

---

## State directory

All state lives in `.gan/` in the current working directory. Create it if it does not exist.

### progress.json schema
```json
{
  "status": "planning | negotiating | building | evaluating | complete | failed",
  "currentSprint": 0,
  "totalSprints": 0,
  "completedSprints": 0,
  "retryCount": 0
}
```

### File naming
- Spec: `.gan/spec.md`
- Contract draft: `.gan/sprint-{N}-contract-draft.json`
- Final contract: `.gan/sprint-{N}-contract.json`
- Eval feedback: `.gan/sprint-{N}-feedback-{A}.json` (A = attempt index, 0-based)

---

## Execution flow

### Step 0 — Resume check

If `.gan/progress.json` exists and `status` is not `"complete"` or `"failed"`:
- Read it and ask the user: "Found an interrupted run at sprint {currentSprint}/{totalSprints} (status: {status}). Resume? [Y/n]"
- If yes: skip completed sprints and continue from where it left off
- If no: delete `.gan/` contents and start fresh

### Step 1 — Planning phase

Update `progress.json`: `status: "planning"`

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
- Spawn `gan-planner` agent with that prompt

After the planner finishes, read `.gan/progress.json` to get `totalSprints`.

---

### Step 2 — Sprint loop

For each sprint from 1 to `totalSprints`:

**Skip if already completed:**
If `completedSprints >= sprint` in progress.json, log `Sprint {N}: already complete, skipping` and continue.

#### 2a — Contract negotiation

Update `progress.json`: `status: "negotiating"`, `currentSprint: N`, `retryCount: 0`

1. Spawn `gan-contract-proposer` agent (no additional prompt needed — it reads state files)
2. Spawn `gan-contract-reviewer` agent (no additional prompt needed — it reads state files)

Verify `.gan/sprint-{N}-contract.json` exists before continuing. If missing, log error and stop.

#### 2b — Build-evaluate retry loop

For retry = 0 to `maxRetries` (inclusive):

**Build:**

Update `progress.json`: `status: "building"`, `retryCount: retry`

Build generator prompt:
- Base: `Sprint {N}, attempt {retry}`
- If `--target` was provided, append: `TARGET_DIR: <path>`

Spawn `gan-generator` agent with that prompt.

**Evaluate:**

Update `progress.json`: `status: "evaluating"`

Spawn `gan-evaluator` agent (no additional prompt needed — it reads state files).

**Check result:**

Read `.gan/sprint-{N}-feedback-{retry}.json`. Parse the `passed` field.

- **If `passed: true`:**
  - Increment `completedSprints` in progress.json
  - Log: `✓ Sprint {N} PASSED on attempt {retry + 1}`
  - Break retry loop, continue to next sprint

- **If `passed: false` and retry < maxRetries:**
  - Log: `✗ Sprint {N} failed attempt {retry + 1}, retrying...`
  - Continue retry loop (increment retry)

- **If `passed: false` and retry == maxRetries:**
  - Update `progress.json`: `status: "failed"`
  - Log: `✗ Sprint {N} FAILED after {maxRetries + 1} attempts — stopping`
  - Print summary table (see Step 3)
  - **Stop the entire harness. Do not continue to further sprints.**

---

### Step 3 — Completion

Update `progress.json`: `status: "complete"` (only if all sprints passed)

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
════════════════════════════════════════
```

---

## Critical rules — do not deviate

1. **Never exceed `maxRetries`**. If the retry counter reaches `maxRetries` and the sprint still fails, stop immediately. Do not spawn another generator.

2. **Always read `progress.json` before spawning an agent**. State must be current before each agent call.

3. **Always verify state files exist** after each agent returns before proceeding. If an expected file is missing, log the error and stop.

4. **The orchestrator owns `progress.json`**. Individual agents may write status updates to it, but the orchestrator is the final authority on `completedSprints` and overall `status`.

5. **Do not modify code directly**. The orchestrator only reads state files and spawns agents. All code changes are made by the generator agent.
