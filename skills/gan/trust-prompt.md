# Trust prompt

The framework shows this prompt when `/gan` validation reports that this
project's committed config declares commands the framework would run, and the
current contents are not approved in your trust cache. Nothing the project
declares runs until you choose.

The orchestrator renders **one** of the two variants below, picked on whether
`getTrustState(projectRoot)` reports a prior approval for this project:

- no prior approval → **Variant 1 — first introduction**
- a prior approval exists → **Variant 2 — config changed since approval**

The trust hash covers the bytes of the committed overlay files under
`.claude/gan/` (the project overlay, every `.claude/gan/stacks/*.md`, every
`.claude/gan/modules/*.yaml`). It does **not** cover the scripts those commands
invoke — review those in the same diff as the overlay. Approving covers the
current contents exactly; any later edit to a hashed file invalidates the
approval and this prompt fires again.

## Variant 1 — first introduction (no prior approval)

```
This project's config declares commands /gan would run on your behalf.
  Found: <N> evaluator.additionalChecks
         <M> project-tier stack file(s) with command overrides
  Approval gates these config files only — the <K> in-repo scripts they
  invoke are NOT in the hash. Review those in git as part of your PR.

  [v] view the declared commands
  [a] approve and run
  [r] run with --no-project-commands (skip project-defined commands)
      Recommended when running an unfamiliar project for the first time.
  [c] cancel
```

## Variant 2 — config changed since approval (a prior approval exists)

```
This project's config has changed since you approved it.
  Affected: <N> evaluator.additionalChecks (<a> added, <m> modified)
            <M> project-tier stack file(s) with command overrides
  Approval gates these config files only — the <K> in-repo scripts they
  invoke are NOT in the hash. Review those in git as part of your PR.

  [v] view the diff
  [a] approve and run
  [r] run with --no-project-commands (skip project-defined commands)
      Recommended when reviewing someone else's branch.
  [c] cancel
```

The variants differ only in the lead-in line, the count framing (`Found` vs
`Affected`), the `[v]` action's content (declared commands vs a diff against the
approved hash), and the `[r]` recommendation hint. The four options and the
script-blind-spot disclosure are identical.

## What each choice does

- `[v]` view — calls `getTrustState(projectRoot)` and prints a high-level summary
  (counts of `additionalChecks`, per-stack command overrides). Variant 1 lists the
  declared commands; Variant 2 summarises what changed since the approved hash. To
  inspect the actual edits, run:

      git diff <approvedCommit>..HEAD -- .claude/gan/

  when an `approvedCommit` was captured at the previous approval, or fall back to:

      git log -- .claude/gan/

  otherwise. Reviewing the in-repo scripts those commands invoke is part of the same
  PR review — the hash does not cover them. After viewing, the prompt re-asks.

- `[a]` approve and run — calls `trustApprove(projectRoot, currentHash)` and re-runs
  `validateAll()`. The approval is recorded in `~/.claude/gan/trust-cache.json` with
  the current ISO-8601 timestamp and (when available) the git HEAD SHA captured at
  approval time. Subsequent runs against the same contents skip this prompt.

- `[r]` run with `--no-project-commands` — runs this invocation only, skipping every
  project-declared command. Nothing is written to the cache; the prompt fires again
  next time.

- `[c]` cancel — returns control to you without running any commands and without
  modifying the trust cache.
