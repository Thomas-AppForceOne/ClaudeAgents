# R5 — Trust-cache reference implementation

## Problem

F4 specifies the trust-cache contract: hash format, cache location and shape, `UntrustedOverlay` error code, interactive prompt behavior, `GAN_TRUST` env var, `--no-project-commands` runtime flag. Something has to actually implement those — compute hashes, persist the cache, integrate with `validateAll()`, drive the prompt UX, and route the runtime flag through to the per-tier command-execution paths.

R5 is that reference implementation.

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

- `trustApprove(projectRoot, contentHash, note?)` → writes a record to the cache.
- `trustList()` → returns all current trust records.
- `trustRevoke(projectRoot)` → removes records for a project.
- `getTrustState(projectRoot)` → returns whether the current `(projectRoot, current-hash)` is approved, with diff details if not.

### Hash computation

Implements F4's algorithm: SHA-256 over the concatenated content of every file matching the union of these globs, sorted lexicographically:

- `.claude/gan/project.md`
- `.claude/gan/stacks/*.md`
- `.claude/gan/modules/*.yaml`

Files are read as raw bytes; no normalisation. Adding a single space invalidates the hash. This is intentional — review-time scrutiny is the threat model's first line of defense; subtle whitespace changes are exactly the kind of thing the cache should re-prompt for.

The hash function is exposed as `trust/hash.js` so the lint script (R4) and any future tooling can compute the same hash deterministically.

### Cache I/O

Writes to `~/.claude/gan/trust-cache.json`. File format:

```json
{
  "schemaVersion": 1,
  "approvals": [
    {
      "projectRoot": "/Users/thak/projects/example",
      "aggregateHash": "sha256:abc123...",
      "perFileHashes": {
        ".claude/gan/project.md": "sha256:def456...",
        ".claude/gan/stacks/android.md": "sha256:ghi789..."
      },
      "approvedAt": "2026-04-25T14:33:21Z",
      "approvedCommit": "a1b2c3d4e5f6...",
      "note": "ok, reviewed PR #142"
    }
  ]
}
```

Per-file hashes are stored alongside the aggregate so `getTrustDiff()` can report exactly which files changed since approval — without storing previous file *contents* (which would balloon the cache and create a target for attackers).

`approvedCommit` records the git HEAD SHA at approval time (resolved via `git rev-parse HEAD` inside `projectRoot`; absent if `projectRoot` is not a git working tree). Stored so the trust prompt's `[v]` follow-up can suggest a precise `git diff <approvedCommit>..HEAD -- <changed-paths>` instead of the looser `git log` it would otherwise have to fall back to. Optional field: an entry without `approvedCommit` is still valid; the follow-up suggestion drops down to "find the commit that contains the previous content."

**File mode.** Created with mode `0600` (user read/write only). The `0600` is set at file-creation time (the canonical "verification" point); on subsequent reads and writes, the cache I/O implementation verifies the mode and refuses to proceed if the file became world-readable or group-readable. The first-ever write is therefore the *establishment* of the bit, not a check against an existing one — there is no file to verify yet. Documented so the spec is honest about which call enforces the mode.

**Path canonicalisation.** `projectRoot` is canonicalised before keying via `fs.realpathSync.native(projectRoot)` (Node) or its equivalent. Trailing slashes are removed, symlinks are resolved, and case-insensitive filesystems are normalised by canonical-path comparison. Two cache entries can never refer to the same on-disk directory under different keys.

**Concurrency.** Reads/writes are atomic (temp-file + rename) for individual operations. Cross-process concurrency is handled with an OS-level advisory lock (`flock` on POSIX; equivalent on Windows): the writer acquires an exclusive lock on `~/.claude/gan/.trust-cache.lock` for the read-modify-write cycle. Two terminal windows running `/gan` against two different projects simultaneously serialise on the lock; neither loses an update. The lock file's existence does not interfere with the cache; only the lock state matters.

**Corruption handling.** The file is created on first write. Missing file is equivalent to "no approvals." A malformed file is **not** silently regenerated — it's a `TrustCacheCorrupt` structured error with shell remediation: `rm ~/.claude/gan/trust-cache.json` (or instruct the user to inspect first). Per F4's user-facing error text discipline, the message refers to "the trust cache file," not "the npm package" or "the Node MCP server."

### CI onboarding: trust manifest export/import

`approved-hashes-only` mode requires the cache to be present in the CI runner's filesystem. F4 said this without specifying how. R5 ships:

- `gan trust export [--out=trust-manifest.json]` — writes the current trust cache (or a project-scoped slice if `--project-root` is set) to a JSON file in the same shape as the cache.
- `gan trust import <trust-manifest.json>` — reads the file and merges its approvals into the local cache. Each imported approval is logged with provenance ("imported from trust-manifest.json on 2026-04-27").

**Recommended CI pattern:** the repo commits a `.claude/gan/trust-manifest.json` (or stores it as a CI secret if the org prefers). The CI runner's `install.sh --no-claude-code` step calls `gan trust import .claude/gan/trust-manifest.json`. `GAN_TRUST=approved-hashes-only` then operates against the imported approvals.

The manifest format is identical to the cache so users do not learn two formats. Committing the manifest exposes the maintainer's approvals (timestamps, notes) but not any secret material; if `notes` are sensitive, omit them via `gan trust export --no-notes`.

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

The `/gan` skill orchestrator (E1's scope) presents the prompt when `validateAll()` returns `UntrustedOverlay`. Implementation:

- The skill reads the user's choice from stdin.
- On `[v]` (view diff): the skill calls a new `getTrustDiff(projectRoot)` MCP tool that returns a structured diff against the previous approval, including the approved commit SHA if one was captured. Because the cache stores **per-file hashes**, not per-file contents, the diff reports *which* files changed (compared to the approved per-file hash map) but not the actual content delta. The skill then offers the user a one-line follow-up suggestion: when `approvedCommit` is present, `run git diff <approvedCommit>..HEAD -- <changed-paths>`; when absent (e.g. project not under git, or older approval predating the field), `run git log -- <changed-paths>` and pick the commit you trust. The user is expected to use git for content review; the trust prompt reports *that* something changed and *which files*, not *what* changed.
- On `[a]` (approve): calls `trustApprove(projectRoot, currentHash)` and re-runs `validateAll()`.
- On `[r]` (--no-project-commands): sets the runtime flag and continues without writing to the cache.
- On `[c]` (cancel): returns control to the user.

The prompt text itself lives in `skills/gan/trust-prompt.md` so it can be edited without touching code.

### `GAN_TRUST` environment variable handling

Read once at server startup, cached for the session. Logged in the startup banner:

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

## Acceptance criteria

- `~/.claude/gan/trust-cache.json` is created on first `trustApprove` call; subsequent calls update it atomically without truncating.
- A corrupted trust cache produces `TrustCacheCorrupt` instead of being silently regenerated.
- `validateAll()` returns `UntrustedOverlay` for a project whose committed files contain `evaluator.additionalChecks` and whose current hash is not approved.
- After `[a]` approval, the same project on subsequent runs does not re-prompt — until any byte of a hashed file changes.
- `GAN_TRUST=strict` (default) causes CI runs to fail closed with `UntrustedOverlay` for any unapproved hash.
- `GAN_TRUST=unsafe-trust-all` skips the trust check; the startup banner logs a warning every run.
- `/gan --no-project-commands` against a project with `evaluator.additionalChecks` skips those checks; the run's startup log lists every skipped command and every tier-1/2-to-tier-3 fallback.
- `planner.additionalContext: ["../../etc/passwd"]` produces a `PathEscape` error.
- A symlink under `.claude/gan/` whose target resolves outside the project root produces a `PathEscape` error.
- The hash function is deterministic across machines (same files → same hash on macOS, Linux, Windows).

## Dependencies

- F1 (filesystem layout — cache lives in user-scope zone 1)
- F2 (the API the trust check extends; the new error code lands in F2's enum)
- F3 (the `additionalContext.path_resolves` invariant catalog gains the `PathEscape` rule)
- F4 (the contract this implements)
- R1 (the server this code runs inside)

## Bite-size note

Sprint slices, in order:

1. `trust/hash.js` + tests — deterministic hash function. No integration; just the math. Can land before any other R5 work.
2. `trust/cache-io.js` + tests — read/write the cache file with atomicity and `TrustCacheCorrupt` handling.
3. `validateAll()` integration — `UntrustedOverlay` return path; `GAN_TRUST` env handling.
4. `getTrustState()` and `getTrustDiff()` MCP tools.
5. `trustApprove`, `trustList`, `trustRevoke` MCP tools.
6. Interactive prompt in `skills/gan/trust-prompt.md` (E1 sprint slice; coordinates with R5).
7. `--no-project-commands` runtime flag routing through the orchestrator and evaluator.
8. `path-escape.js` invariant.

Slices 1–3 are the minimum viable trust check. Slice 6 is in E1's territory but documented here so the cross-team coordination is visible.
