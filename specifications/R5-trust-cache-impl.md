# R5 — Trust-cache reference implementation (v1)

## Problem

F4 specifies the trust-cache contract: hash format, cache location and shape, `UntrustedOverlay` error code, interactive prompt behavior, `GAN_TRUST` env var, `--no-project-commands` runtime flag. Something has to actually implement those — compute hashes, persist the cache, integrate with `validateAll()`, drive the prompt UX, and route the runtime flag through to the per-tier command-execution paths.

R5 is that reference implementation. The v1 scope is **deliberately narrow**: aggregate hash + approve/cancel + interactive prompt + two `GAN_TRUST` modes + `--no-project-commands` + `PathEscape`. Anything richer (per-file hash diff, CI manifest export/import, cross-process locking, an `approved-hashes-only` mode that needs the manifest) is deferred to a follow-up trust-UX spec authored when concrete CI use exposes the gap.

## Proposed change

A Node 18+ module integrated into the Configuration MCP server (R1) and the `/gan` skill (E1's orchestrator scope).

### Repository additions

```
src/config-server/
  trust/
    hash.js                     # SHA-256 over committed command-declaring files
    cache-io.js                 # ~/.claude/gan/trust-cache.json read/write
    integration.js              # validateAll() hook
  invariants/
    path-escape.js              # F4's PathEscape check (planner/proposer additionalContext, symlinks)
```

```
skills/gan/
  trust-prompt.md               # the interactive UX text (loaded by SKILL.md)
```

`src/config-server/tools/writes.js` gains four new MCP tools (per F2 versioning):

- `trustApprove(projectRoot, note?)` → writes a record to the cache. The server computes the content hash from the current state of the committed files (per the hash algorithm below); the caller never passes the hash, eliminating any caller/server hash-mismatch surface. Returns `{ mutated: true, ... }` per F2. (Earlier drafts of this spec required the caller to pass `contentHash` — that signature was rejected before R5 shipped; the current spec text and implementation both use the projectRoot-only form.)
- `trustRevoke(projectRoot)` → removes records for a project. Returns `{ mutated, ... }` per F2.
- `trustList()` → returns all current trust records (read-only).
- `getTrustState(projectRoot)` → returns whether the current `(projectRoot, current-hash)` is approved, plus a high-level "what kind of change" summary if not (counts of `additionalChecks` entries, command-overrides, etc.). Does **not** return a per-file diff in v1; users reading the change inspect it via git.

### Hash computation

Implements F4's algorithm: SHA-256 over the concatenated content of every file matching the union of these globs, sorted lexicographically:

- `.claude/gan/project.md`
- `.claude/gan/stacks/*.md`
- `.claude/gan/modules/*.yaml`

Files are read as raw bytes; no normalisation. Adding a single space invalidates the hash. This is intentional — review-time scrutiny is the threat model's first line of defense; subtle whitespace changes are exactly the kind of thing the cache should re-prompt for.

The hash function is exposed as `trust/hash.js` so the lint script (R4) and any future tooling can compute the same hash deterministically.

### Cache I/O

Writes to `~/.claude/gan/trust-cache.json`. v1 file format:

```json
{
  "schemaVersion": 1,
  "approvals": [
    {
      "projectRoot": "/Users/thak/projects/example",
      "aggregateHash": "sha256:abc123...",
      "approvedAt": "2026-04-25T14:33:21Z",
      "approvedCommit": "a1b2c3d4e5f6...",
      "note": "ok, reviewed PR #142"
    }
  ]
}
```

`approvedCommit` records the git HEAD SHA at approval time (resolved via `git rev-parse HEAD` inside `projectRoot`; absent if `projectRoot` is not a git working tree). Stored so the trust prompt's `[v]` follow-up can suggest a precise `git diff <approvedCommit>..HEAD -- .claude/gan/` instead of the looser "find the commit that contains the previous content" fallback. Optional field: an entry without `approvedCommit` is still valid; the follow-up suggestion drops down to the looser form.

**File mode.** Created with mode `0600` (user read/write only). The `0600` is set at file-creation time (the canonical "establishment" point); on subsequent reads and writes, the cache I/O implementation verifies the mode and refuses to proceed if the file became world-readable or group-readable.

**Path canonicalisation.** `projectRoot` is canonicalised before keying per F3's canonical determinism pins. Two cache entries can never refer to the same on-disk directory under different keys.

**Concurrency.** Reads/writes are atomic for individual operations (temp-file + rename). v1 does not implement cross-process advisory locks — two terminal windows running `/gan` against two different projects simultaneously may interleave their cache reads/writes; the worst case is one approval briefly being missed and re-prompted on the next run, not corruption. Cross-process locking is one of the deferred bits below; if real users hit the race in practice, that's the trigger to author the follow-up spec.

**Corruption handling.** The file is created on first write. Missing file is equivalent to "no approvals." A malformed file is **not** silently regenerated — it's a `TrustCacheCorrupt` structured error with shell remediation: `rm ~/.claude/gan/trust-cache.json` (or instruct the user to inspect first). Per F4's user-facing error text discipline, the message refers to "the trust cache file."

### Integration with `validateAll()`

`validateAll()` (F2) gains a final phase after schema validation and cross-file invariants:

```
validateAll():
  schema_validate(...)
  cross_file_invariants(...)
  trust_check(...)         # new
```

The trust check:

1. Detect whether any committed file contains a command-declaring field. If none, skip the check; trust is irrelevant for this project.
2. Compute the current content hash.
3. Look up `(projectRoot, currentHash)` in the cache.
4. If approved, pass.
5. If not approved, return `UntrustedOverlay` per F4.

### Interactive prompt

The `/gan` skill orchestrator (E1's scope) presents the prompt when `validateAll()` returns `UntrustedOverlay`. v1 implementation:

- The skill reads the user's choice from stdin.
- On `[v]` (view): the skill calls `getTrustState(projectRoot)` and prints the high-level summary (counts of `additionalChecks`, command-overrides, etc.) plus a one-line follow-up suggestion: *"To inspect what changed, run `git diff <approvedCommit>..HEAD -- .claude/gan/` (when an approved commit was captured) or `git log -- .claude/gan/` (otherwise) and read the diff. The trust hash also does not transitively cover scripts these commands invoke — review those in the same diff as part of your PR."* Re-prompts after the suggestion. v1 deliberately points at git rather than building a structured per-file diff in the prompt itself; users always have git, the cost of the structured diff is per-file hash storage + a richer MCP tool, and the gain is small (git diff is what reviewers actually use anyway).
- On `[a]` (approve): calls `trustApprove(projectRoot, currentHash)` and re-runs `validateAll()`.
- On `[r]` (`--no-project-commands`): sets the runtime flag and continues without writing to the cache.
- On `[c]` (cancel): returns control to the user.

The prompt text itself lives in `skills/gan/trust-prompt.md` so it can be edited without touching code.

### `GAN_TRUST` environment variable handling

Two values in v1: unset (interactive prompt; default), `strict` (fail closed; CI default), `unsafe-trust-all` (bypass; development only). Read once at server startup, cached for the session. Logged in the startup banner:

```
[gan-config-server] starting; trust mode: strict
```

`unsafe-trust-all` produces a loud warning every run:

```
[gan-config-server] WARNING: GAN_TRUST=unsafe-trust-all; project-defined
                            commands will run without trust checks. Use
                            only on self-hosted CI for trusted branches.
```

### `--no-project-commands` runtime flag routing

The flag sets a boolean on the resolved snapshot exposed by `getResolvedConfig()`:

```json
{
  "runtimeMode": {
    "noProjectCommands": true
  },
  ...
}
```

Agents (and the orchestrator's command-running paths) consult this flag before executing any command sourced from tier-1 or tier-2:

- Evaluator skips `evaluator.additionalChecks` whose source tier is not `repo`.
- Evaluator falls back from tier-1/tier-2 `auditCmd` / `buildCmd` / `testCmd` / `lintCmd` to the tier-3 default for the matching stack name.
- If no tier-3 fallback exists for a project-tier-only stack, the stack is treated as not-defined and the user gets a warning naming the stack.

The skipped commands, fallbacks, **and any custom (project-tier-only) stacks that were dropped entirely** are recorded in the run's startup log (per O1). The log content includes:

- Skipped commands: each `additionalChecks` entry that didn't run, with its source tier.
- Tier fallbacks: each `<stack>.<field>` that fell back from tier-1/2 to tier-3, with both values.
- **Custom stacks dropped:** any project-tier-only stack with no tier-3 match, with the stack name and a one-line note ("custom stack <name> entirely skipped — no tier-3 fallback exists; review the stack file directly to understand what its commands would have done").

The user reviewing someone's PR who picked `[r]` should be able to see, from the log alone, which surfaces of the project went un-evaluated.

### `PathEscape` invariant

Implemented in `src/config-server/invariants/path-escape.js`. Runs as part of the cross-file invariants phase. For every path declared in:

- `planner.additionalContext`
- `proposer.additionalContext`
- (Future splice points that introduce paths must add their selectors here.)

Resolve relative to the project root, follow symlinks for existence, and verify the resolved real path is a descendant of the project root. Failure produces a `PathEscape` structured error with the offending path.

### Logging

Every trust-cache mutation is logged to `.gan-state/runs/<run-id>/logs/trust.log` (when in a `/gan` run) or stderr (CLI). Log entries include the timestamp, the project root, the hash, and the action (approve / revoke / check).

### `gan` CLI surfaces

R5 owns the `gan trust *` CLI subcommands (relocated from R3 so the trust UX lives next to its implementation). v1 surfaces:

| Subcommand | Effect |
|---|---|
| `gan trust info [--project-root=<path>]` | Show approval status, command-paths the approved overlay invokes, and a reminder that the trust hash does not cover those targets transitively. |
| `gan trust approve --project-root=<path> [--note=<text>]` | Approve the current content hash for the named project. Trust-mutating; `--project-root` is REQUIRED (no cwd default), to prevent approving the wrong project from the wrong directory. |
| `gan trust revoke --project-root=<path>` | Remove approval. Trust-mutating; `--project-root` is REQUIRED. |
| `gan trust list` | List all current approvals. |

`--help` / `-h` on each subcommand follows the contract in R3 (usage, flags, examples, exit codes). Help output never references maintainer-only scripts.

## Deferred to a follow-up spec

The following are intentionally absent from v1; the follow-up trust-UX spec is authored when CI use, multi-process workflows, or richer review UX exposes the gap:

- **Per-file hashes in the cache.** Precondition for a structured per-file diff in the `[v]` branch. v1 instead points at `git diff`; this is sufficient for individual users.
- **`getTrustDiff()` MCP tool.** A structured diff against the previous approval. v1 provides only the high-level summary via `getTrustState`.
- **`gan trust export` / `gan trust import` manifest.** A JSON file format for shipping approvals into CI. Without this, `GAN_TRUST=approved-hashes-only` (also deferred) cannot be plumbed into a CI runner.
- **`GAN_TRUST=approved-hashes-only` mode.** A CI mode that uses an imported manifest as the trust source. Pre-1.0, the recommended CI pattern is `GAN_TRUST=strict` — every CI run validates against committed config — which avoids needing a separate manifest at all. If real CI workflows hit a case where strict-mode is impractical, that's the trigger.
- **Cross-process advisory locks** (`flock` on the trust-cache file). Two-terminal-windows races are tolerable in v1 (worst case: one approval briefly missed, re-prompted next run). If practitioners hit the race in practice, this is the trigger.

The deferred bits don't require any new contract surface — adding them later is additive (new fields in the cache schema, new MCP tools, new env var values, new CLI commands). v1's `schemaVersion: 1` is forward-compatible with the v2 cache schema in the standard schemaVersion-bump-then-update-readers way.

## Acceptance criteria

- `~/.claude/gan/trust-cache.json` is created on first `trustApprove` call; subsequent calls update it atomically without truncating.
- A corrupted trust cache produces `TrustCacheCorrupt` instead of being silently regenerated.
- `validateAll()` returns `UntrustedOverlay` for a project whose committed files contain `evaluator.additionalChecks` and whose current hash is not approved.
- After `[a]` approval, the same project on subsequent runs does not re-prompt — until any byte of a hashed file changes.
- `GAN_TRUST=strict` causes CI runs to fail closed with `UntrustedOverlay` for any unapproved hash.
- `GAN_TRUST=unsafe-trust-all` skips the trust check; the startup banner logs a warning every run.
- `/gan --no-project-commands` against a project with `evaluator.additionalChecks` skips those checks; the run's startup log lists every skipped command and every tier-1/2-to-tier-3 fallback.
- `planner.additionalContext: ["../../etc/passwd"]` produces a `PathEscape` error.
- A symlink under `.claude/gan/` whose target resolves outside the project root produces a `PathEscape` error.
- The hash function is deterministic across machines (same files → same hash on macOS, Linux, Windows).
- `gan trust approve` / `revoke` / `list` / `info` all run from the CLI, exit 0 on success, and surface structured errors verbatim on failure. `approve` and `revoke` refuse to run without an explicit `--project-root`.

## Dependencies

- F1 (filesystem layout — cache lives in user-scope zone 1)
- F2 (the API the trust check extends; the new error code lands in F2's enum)
- F3 (the `additionalContext.path_resolves` invariant catalog gains the `PathEscape` rule; F3's Determinism section pins path-canonicalisation)
- F4 (the contract this implements)
- R1 (the server this code runs inside)

## Bite-size note

Sprint slices, in order:

1. `trust/hash.js` + tests — deterministic SHA-256 aggregate. No integration; just the math. Can land before any other R5 work.
2. `trust/cache-io.js` + tests — read/write the cache file with atomicity, `0600` mode establishment + verification, `TrustCacheCorrupt` handling.
3. `validateAll()` integration — `UntrustedOverlay` return path; `GAN_TRUST` env handling.
4. `getTrustState`, `trustApprove`, `trustList`, `trustRevoke` MCP tools.
5. Interactive prompt in `skills/gan/trust-prompt.md` (E1 sprint slice; coordinates with R5).
6. `--no-project-commands` runtime flag routing through the orchestrator and evaluator.
7. `path-escape.js` invariant.
8. `gan trust *` CLI subcommands (R3 plumbing; trivial — pass-through to MCP tools above).

Slices 1–3 are the minimum viable trust check. Slice 5 is in E1's territory but documented here so the cross-team coordination is visible.
