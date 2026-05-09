# I1 — Self-contained install correctness

## Problem

The first dogfooding session caught the framework's install pipeline in two failure modes that produced "successful" installs that did not, in fact, work:

1. **Symlinks back to the source repo.** `install.sh` originally created symlinks at `~/.claude/agents/gan-*.md` pointing into `<repo>/agents/*.md`, and a single symlink at `~/.claude/skills/gan` pointing into `<repo>/skills/gan`. The install therefore depended on the source repo staying at its install-time path forever — moving or deleting the repo broke every downstream `/gan` invocation. Users reasonably expect "install" to mean "self-contained": the source clone is a build input, not a runtime dependency.

2. **No build-on-install.** The framework's `package.json` declared `"bin": { "claudeagents-config-server": "./dist/config-server/index.js" }` but had no `prepare` script. `npm install -g .` succeeded "logically" — npm linked the package metadata — while skipping the bin shim because its target file did not exist (`dist/` was never compiled). The install reported success on a system that could not start the MCP server. Claude Code then silently failed to register the `/gan` skill because the spawned config-server process exited immediately. The user saw "ClaudeAgents installer: install complete." followed by "/gan: tool not installed" — exactly the contradiction the install pipeline must not produce.

Both failures share a shape: the install reports success while leaving the system in a state that cannot run the framework. **The install pipeline must be honest** — when it says "install complete," every downstream surface (`/gan` skill, `gan` CLI, MCP server bin) must actually work.

I1 is the first spec under the **I** (install / installer) phase code, covering the install pipeline's correctness layer (this spec), user-facing surfaces (I2), and uninstall + version policy (I3).

## Proposed change

### Real-file copies, not symlinks

`install.sh`'s `install_agents_and_skills()` function (renamed from the legacy `link_agents_and_skills()`) copies files from the source repo into `~/.claude/`:

- Each `<repo>/agents/*.md` is copied to `~/.claude/agents/<name>.md` as a regular file.
- The `<repo>/skills/gan/` directory is copied recursively to `~/.claude/skills/gan/` as a real directory.

After install completes, the source repo can be moved, renamed, or deleted without breaking the install. The copies under `~/.claude/` are the framework's runtime — the source repo's role ends at install-time.

**Migration from legacy installs.** A user who installed under the symlink-based pattern runs `install.sh` again to migrate. The function detects the legacy state at each target path (a symlink rather than a regular file) and removes the symlink before the copy lands. The migration is silent — no separate user action is required, no `--migrate` flag. The legacy state is gone after one re-install.

**STATE_LOG entries** track copies for rollback: `copied-file:<absolute-path>` for each agent file, `copied-dir:<absolute-path>` for the skill directory. The rollback handler in `install.sh` removes regular files and directories at those paths defensively (only removes if the target is still a real file / real directory; a symlink replacement by a third party leaves the path alone).

### `prepare` script in `package.json`

`package.json` declares `"scripts": { "prepare": "npm run build", ... }`. npm runs `prepare` automatically after `npm install` — including `npm install -g .` — with `devDependencies` temporarily installed so `tsc` is available. After `prepare` completes, `dist/` is populated and the bin shim points at a real file.

This is the load-bearing fix: without `prepare`, npm has no signal that the package needs compilation, and the bin shim references a nonexistent target.

### Post-install bin verification

After `install_mcp_server` runs, `install.sh` calls a `verify_mcp_bin_on_path` helper that asserts `command -v claudeagents-config-server` returns a path. The helper is wrapped in its own function (rather than inlined into `main()`) because `return 1` from a helper triggers the ERR trap routed through `on_error -> rollback`, while `return 1` directly from `main()` does not — the trap is installed inside `main()` and expires when main returns, leaving no handler at the calling site.

When verification fails, the installer halts with a structured error and rolls back partial state:

> ClaudeAgents installer: `claudeagents-config-server` is not on PATH after install. The framework's npm package linked but its executable did not. This typically means the build artifact at `dist/` was not produced — verify `npm run build` runs cleanly inside `<REPO_ROOT>`, then re-run `./install.sh`.

This catches not only the "no `prepare` script" failure but any future regression where the npm step succeeds while skipping the bin shim — corrupted package.json, custom npm config, npm permission errors that don't surface as non-zero exit, etc. The check is cheap and the failure mode is otherwise silent.

### `engines` upper bound lifted

`package.json`'s `engines.node` declaration changes from `">=20.10.0 <23"` to `">=20.10.0"` (no upper bound). Rationale: the upper bound was a "tested-against" cap, not a "known-incompatible" cap. Under Node 25+ the framework runs cleanly; the original `<23` cap surfaced as an `EBADENGINE` warning during every `npm install -g .` against a current Node, even though install succeeded.

The actual Node compatibility floor — the lower bound of `20.10.0` — is what matters for runtime correctness, and it stays as a hard bound. `install.sh` enforces the same lower bound at prereq-check time. The upper bound's removal is honesty about what the framework has actually been tested under: it works on every Node major from 20.10 forward; the framework will issue an advisory for Node majors above its tested ceiling (per I3's Node version policy) but does not refuse to install.

### Idempotency

`install.sh` is fully idempotent under the new copy-based model. A second run:

- Copies fresh agent files, overwriting the existing copies in place. This is what users want when they re-run after pulling new framework code: the latest content lands.
- Recreates `~/.claude/skills/gan/` from the source. If the legacy state (symlink) was at the path, it is removed first. If the directory exists from a prior copy install, it is removed first to ensure stale files from prior versions don't survive.
- Skips `npm install -g .` if `version_probe_mcp` reports a version matching `package.json`'s declared version (no work to do). When versions differ, `install_mcp_server` runs.
- Re-runs `verify_mcp_bin_on_path`. If a previous install left a stale bin from a now-deleted dist target, this catches it.

The combination — overwrite copies, version-probe-then-install, verify — means re-running `install.sh` always produces a coherent post-install state regardless of the starting state.

### What I1 does not do

- Address user-facing install surfaces (post-install message, first-run welcome banner, permission consent flow). Those are I2's scope.
- Address uninstall or Node version policy. Those are I3's scope.
- Address MCP registration's absolute-path requirement (a separate dogfooding finding). That is also I3's scope.
- Address Claude Code restart UX. Restart is implicit in any change to `~/.claude.json` or `~/.claude/skills/`; I1's contract is the on-disk state, not the running session.
- Provide platform support beyond macOS and Linux. Windows installs are out of scope per the framework's existing platform decisions.

## Field encodings

I1 introduces no new schema-bearing types. STATE_LOG entries are line-oriented strings parsed by `install.sh`'s rollback handler (`<kind>:<absolute-path>`); the kinds are documented at the top of `install.sh`. No JSON schema, no error-code additions.

## Examples

The post-install state under the new model:

```
~/.claude/agents/
├── gan-contract-proposer.md     # real file (8140 bytes), copied from <repo>/agents/
├── gan-contract-reviewer.md
├── gan-evaluator.md
├── gan-generator.md
└── gan-planner.md

~/.claude/skills/gan/
├── SKILL.md                     # real file, copied from <repo>/skills/gan/
└── trust-prompt.md

/opt/homebrew/bin/claudeagents-config-server
└── -> ../lib/node_modules/@claudeagents/config-server/dist/config-server/index.js
    (npm bin shim, target is real file produced by `prepare` script)
```

After running `rm -rf <repo>` (or moving the repo), the framework continues to work — every artifact above lives outside the repo.

The legacy state being migrated:

```
~/.claude/agents/
├── gan-contract-proposer.md -> /Users/taa/AppForceOne/projects/ClaudeAgents/agents/gan-contract-proposer.md
└── ...                       (symlinks back to source)

~/.claude/skills/gan -> /Users/taa/AppForceOne/projects/ClaudeAgents/skills/gan
```

After running `./install.sh` once, every symlink above is replaced with a real file or directory copy. No user action beyond re-running `install.sh`.

## Acceptance criteria

### Automated checks

- After `./install.sh` completes, `lstat(~/.claude/agents/gan-*.md).isSymbolicLink()` is `false` for every framework agent file; `isFile()` is `true`.
- After `./install.sh` completes, `lstat(~/.claude/skills/gan).isSymbolicLink()` is `false`; `isDirectory()` is `true`.
- File contents under `~/.claude/agents/` match the source repo's `agents/` byte-for-byte.
- After `./install.sh` completes, `command -v claudeagents-config-server` returns a non-empty path.
- The bin shim's resolved target file exists and is executable.
- `dist/config-server/index.js` exists in the source repo after `npm install -g .` (the `prepare` script produced it).
- A test that pre-creates a legacy symlink-based install at `~/.claude/agents/` and `~/.claude/skills/gan/`, then runs `./install.sh` once, ends with real-file copies (not symlinks) at the same paths.
- A simulated install where the npm step succeeds but the bin is not on PATH halts with the structured `claudeagents-config-server is not on PATH after install` error and triggers rollback.
- After successful install, removing or moving the source repo does not affect `which gan`, `which claudeagents-config-server`, or `~/.claude/skills/gan/SKILL.md` accessibility.
- `npm install -g .` against a fresh checkout (no pre-existing `dist/`) produces `dist/` via the `prepare` script.
- `npm install -g .` against a Node 25 environment does not emit an `EBADENGINE` warning.
- Re-running `./install.sh` is idempotent: no duplicate STATE_LOG entries are persisted (STATE_LOG is per-run anyway), no duplicate `.gitignore` lines are written, the post-install state matches the first-run state.

### Manual review checks

- The user-facing install messages in success and rollback paths follow the F4 prose-discipline rule (no bare `npm`/`node`/`Node`/`MCP server` outside backticks).
- The `install.sh` help text describes copies, not symlinks, in the "What it does" section.
- The R2 spec is updated to match this contract (copies + `prepare` + bin verification + engines lift).

## Dependencies

- **F1** — zone semantics; `~/.claude/` is zone 1 (configuration), copies under it are framework-owned per the install contract.
- **F2** — structured-error model used by the `claudeagents-config-server is not on PATH` error.
- **F3** — schema authority; the `prepare` script triggers a build that produces the schemas the runtime consumes.
- **R2** — the installer spec; I1 amends R2 in place (copies-not-symlinks, `prepare` script requirement, post-install bin verification, engines lift).
- **R5** — trust cache implementation; copies under `~/.claude/` participate in the trust hash where applicable.

## Bite-size note

Sprintable as:

1. (one sprint) Symlink-to-copy migration: rename `link_agents_and_skills` → `install_agents_and_skills`, replace `ln -sfn` with `cp` / `cp -R`, detect-and-remove legacy symlinks, update STATE_LOG schema.
2. (one sprint) `prepare` script in `package.json` + engines upper-bound lift.
3. (one sprint) Post-install bin verification helper, integrated with the existing ERR-trap rollback. Includes the helper-function-not-inlined rationale documented in the spec.
4. (one sprint) Test updates: install round-trip, migration path, build-failure detection, source-repo-moved scenario.
5. (rides with R2 maintenance) Update R2's "Responsibilities" section to match the new contract.

Slices 1–3 must land in order; slice 4 depends on all three; slice 5 can land in parallel with any of the above.
