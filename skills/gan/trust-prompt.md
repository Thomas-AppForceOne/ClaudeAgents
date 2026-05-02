# Trust prompt

The framework has detected that this project's overlay declares commands
the framework would run, and the current overlay contents have not been
approved by you. Before any project-declared command runs, you must make
a decision.

The trust hash is computed from the bytes of the overlay files under
`.claude/gan/`: the project overlay, every `.claude/gan/stacks/*.md`
file, and every `.claude/gan/modules/*.yaml` manifest. The trust hash
also does not transitively cover scripts these commands invoke — review
those alongside the overlay diff in the same PR.

## Choices

- `[v]` view what changed.
  Calls `getTrustState(projectRoot)` and prints a high-level summary
  (counts of `additionalChecks`, per-stack command overrides). To
  inspect the actual edits, run:

      git diff <approvedCommit>..HEAD -- .claude/gan/

  when an `approvedCommit` was captured at the previous approval, or
  fall back to:

      git log -- .claude/gan/

  otherwise. The trust hash also does not transitively cover scripts
  these commands invoke — review those in the same diff as part of
  your PR. After viewing, the prompt re-asks for a choice.

- `[a]` approve the current hash.
  Calls `trustApprove(projectRoot, currentHash)` and re-runs
  `validateAll()`. The approval is recorded in `~/.claude/gan/trust-cache.json`
  with the current ISO-8601 timestamp and (when available) the git
  HEAD SHA captured at approval time.

- `[r]` run with `--no-project-commands` for this run only.
  Skips every project-declared command for the current invocation. No
  approval is written to the cache; the prompt fires again next time.

- `[c]` cancel.
  Returns control to you without running any commands and without
  modifying the trust cache.

## What the framework will run if you approve

The summary printed by `[v]` lists the commands that would run. Read it
before choosing `[a]`. Approving covers the current overlay contents
exactly; any subsequent edit to the files listed above invalidates the
approval and the prompt fires again.
