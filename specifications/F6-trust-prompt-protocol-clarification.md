# F6 — Trust-prompt protocol clarification

## Problem

The interactive trust prompt — shown when `validateAll()` returns `UntrustedOverlay`, before any project-declared command runs — is under-specified, and its artifacts are inconsistent:

- **No single statement of the orchestrator's obligation.** What the orchestrator must do on `UntrustedOverlay` (show what changed → wait for explicit consent → only then approve) is written nowhere as one checkable rule.
- **`skills/gan/trust-prompt.md` is incomplete.** It renders a single prompt where two are needed — a first-time "introduction" prompt and a "config changed since you approved" prompt.
- **`skills/gan/SKILL.md` § "Trust integration" is inconsistent** — it lists `[a]` / `[r]` / `[c]` but omits the `[v]` (view) option, and restates prompt wording that should live in one place.

The prompt is a protocol the orchestrator is *trusted to follow*, not a gate the server can enforce: `trustApprove` is an ordinary tool the agent can call directly, so the rule below is the whole guarantee. F6 makes that rule explicit and brings the two artifacts into line.

F6 is **documentation + artifact-compliance only.** No `src/` code changes — the trust cache, `trustApprove` / `getTrustState`, `UntrustedOverlay`, the `GAN_TRUST` modes, and `--no-project-commands` already work. It adds **no** server-side enforcement (that is the separate v1.1 "trust-prompt enforcement" task). It introduces no new capability, so the five-question relevance filter is N/A.

## Proposed change

### 1. The trust-prompt contract

On `UntrustedOverlay`, the orchestrator MUST, in order:

1. Render the trust prompt (from `skills/gan/trust-prompt.md`) before reaching any command-execution path.
2. Show what the approval covers — the changed or newly-declared command-bearing fields — and disclose that the trust hash does **not** cover scripts those commands invoke (the user reviews those in the same diff).
3. Wait for explicit consent. Do **not** call `trustApprove` unless the user chose `[a]`.
4. Resolve the choice:
   - `[a]` → call `trustApprove(projectRoot, currentHash)`, then re-validate.
   - `[r]` → run with `--no-project-commands`; write nothing to the cache.
   - `[v]` → show the summary, then re-ask.
   - `[c]` → abort the run.

This ordered list is the single thing a reviewer checks the orchestrator prompt against.

### 2. Two prompt variants in `trust-prompt.md`

`trust-prompt.md` renders one of two variants, chosen on whether `getTrustState(projectRoot)` reports a prior approval:

- **First introduction** (no prior approval): lead-in "This project's config declares commands /gan would run on your behalf." `[v]` lists the declared commands.
- **Subsequent change** (prior approval exists): lead-in "This project's config has changed since you approved it." `[v]` summarizes what changed since the approved hash.

Both variants carry the full `[v]` / `[a]` / `[r]` / `[c]` option set, the same script-blind-spot disclosure, and the same hint that `[r]` is recommended when reviewing someone else's branch or running an unfamiliar project for the first time.

### 3. One wording source; `[v]` / `[a]` / `[r]` / `[c]` everywhere

`trust-prompt.md` is the single source of the rendered prompt text. SKILL.md § "Trust integration" (and any agent prompt that mentions the prompt) describes only *when* it fires and the § 1 obligation — it does not restate the prompt body, and it lists all four options wherever it refers to them (today it drops `[v]`).

### 4. Phase-code disambiguation

"F6" here is **trust-prompt protocol clarification.** F4 carries an old forward-placeholder that uses "F6" for an unrelated "token federation" idea (and "F5" for a "transitive trust" idea); both are superseded by the roadmap's actual slot assignments and are not this work. If either idea is ever pursued it takes a new, unallocated code.

### Out of scope `[deferred-to-v1.1]`

No server-side enforcement of the protocol — rate-limiting, requiring the approval call to echo a content-hash the user just saw, a structured audit log, or scoped capability tokens. That is the v1.1 "trust-prompt enforcement" task. F6 documents the honest posture (a misbehaving orchestrator could skip the prompt and call `trustApprove` directly) but does not close it.

### No new runtime surface; no schema changes

No new flag, env-var value, subcommand, or prompt branch — the `[v]` / `[a]` / `[r]` / `[c]`, `--no-project-commands`, and `GAN_TRUST` surfaces are unchanged (catalogued in [`runtime-knobs.md`](runtime-knobs.md)). No schema additions.

## Acceptance criteria

- One "trust-prompt contract" subsection states the orchestrator's obligation as an ordered, checkable list (render → disclose → await consent → `trustApprove` only on `[a]`).
- `trust-prompt.md` renders both variants (first-introduction and subsequent-change), selected on `getTrustState`, each with the full `[v]` / `[a]` / `[r]` / `[c]` set and the script-blind-spot disclosure.
- SKILL.md § "Trust integration" includes `[v]` and defers prompt wording to `trust-prompt.md` instead of restating it.
- No surface lists a partial option set or restates the prompt body.
- The phase-code disambiguation note is present.
- No enforcement / capability-token / audit-log / rate-limit / content-hash-echo behaviour is added.
- No `src/` change; no new `runtime-knobs.md` entry; no schema change.
- All prompt text uses shell remediation, refers to "the framework" / "ClaudeAgents", and reads cleanly for a developer who only ran `install.sh`.

## Dependencies

None to read. The task relies only on already-working runtime surfaces — `UntrustedOverlay`, `trustApprove` / `getTrustState`, `GAN_TRUST`, `--no-project-commands` — and edits two orchestrator artifacts: `skills/gan/trust-prompt.md` and `skills/gan/SKILL.md`. No `src/` code changes.

## Bite-size note

One sprint, no `src/` changes: write the contract + variants in this spec, bring `trust-prompt.md` to the two-variant shape, and correct SKILL.md § "Trust integration" to include `[v]` and defer wording.
