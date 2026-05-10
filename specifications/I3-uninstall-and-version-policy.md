# I3 — Uninstall and version policy

## Problem

I1 established install correctness; I2 shaped install user surfaces. I3 closes three remaining install-pipeline gaps that surfaced during the first dogfooding cycle:

1. **Uninstall left framework bins on PATH.** `install.sh --uninstall` removed filesystem state under `~/.claude/` and stripped the MCP entry from `~/.claude.json`, but did not run `npm uninstall -g @claudeagents/config-server`. Result: `gan` and `claudeagents-config-server` stayed on PATH after uninstall, contradicting the user's stated intent. The original justification ("other tools may depend on the package") was bogus — the package is namespaced and ships only the framework's two bins; nothing external can depend on it.

2. **Node version cap was a hard error, not a warning.** `install.sh`'s `MAX_NODE_MAJOR` constant rejected newer Node versions outright. The original cap was tested-against discipline (the framework had been validated through Node 22), not a known-incompatibility statement. A user on Node 25 hit a hard `die` and could not install — even though the framework runs cleanly on Node 25. This locked out the user population most likely to file useful dogfooding bug reports (power users on bleeding-edge runtimes).

3. **MCP server was registered with a bare command name.** `install.sh`'s `register_mcp_in_claude_json` wrote `"command": "claudeagents-config-server"` into `~/.claude.json`. Claude Code, launched as a GUI app from the Dock / Spotlight / Finder, inherits a minimal PATH that does NOT include `/opt/homebrew/bin/`, `npm`'s prefix, or any shell-set additions. Bare-command registration silently fails to spawn the MCP server in the GUI context, surfacing as `ConfigApiUnreachable` for the user. The bin works perfectly from a shell — but `/gan` runs inside Claude Code's GUI process, not a shell.

I3 covers the install pipeline's cleanup + hardening layer. None of these are user-facing surfaces (I2's scope) or correctness fixes (I1's scope) — they are operational details that determine whether install / uninstall / re-install cycles produce coherent state, and whether the install survives real macOS launch-time environments.

I3 is the third spec under the **I** (install / installer) phase code.

## Proposed change

### Symmetric uninstall

`install.sh --uninstall` runs `npm uninstall -g @claudeagents/config-server` after removing filesystem state and stripping the MCP entry from `~/.claude.json`. The npm step happens last so a failure there does not prevent the filesystem cleanup (which is the load-bearing part).

**Failure handling.** If `npm uninstall -g` fails (permissions, network, npm absent), the uninstall warns but does not abort:

> Could not remove the globally installed package `@claudeagents/config-server`. Run `npm uninstall -g @claudeagents/config-server` by hand to clean up.

The filesystem state is already gone; the leftover npm package is a strictly smaller residual than the pre-fix behaviour where it was always left behind.

**`npm` not on PATH** (rare but possible — user removed npm after install) produces a similar warning:

> `npm` is not on PATH; cannot remove the globally installed package `@claudeagents/config-server`. Run `npm uninstall -g @claudeagents/config-server` once npm is available.

**Asymmetry with rollback (intentional).** `install.sh`'s rollback path — fired on partial install failure — does NOT run `npm uninstall -g`. The rollback is defensive cleanup of a transient install failure where the user might immediately retry; aggressive npm removal would be hostile. The explicit `--uninstall` invocation is the user's deliberate cleanup intent and IS aggressive. Different intents, different behaviours, documented as such.

### Post-uninstall message

The uninstall success message names the post-uninstall Claude Code restart requirement:

```
ClaudeAgents installer: uninstall complete.
  - Removed N framework file(s) from ~/.claude/.
  - Cleared the framework entry from ~/.claude.json (when present).
  - Removed the globally installed package `@claudeagents/config-server`
    (`gan` and `claudeagents-config-server` are no longer on PATH).

Restart Claude Code to remove `/gan` from the slash-command palette.

Left in place:
  - Per-project zones: `rm -rf .gan-state .gan-cache` (run from each repo) if you want them gone.
  - Project overlays under `.claude/gan/` and the once-per-machine `~/.claude.json` backup are untouched.
```

The "Restart Claude Code to remove `/gan` from the slash-command palette" line is symmetric with the post-install "Restart Claude Code to pick up the new agents, skills, and config server." Both restarts are required — Claude Code reads its skill registry only at session start. Naming the restart in both directions closes the "I uninstalled but `/gan` still shows up in the palette" confusion that is otherwise the next user issue.

### Node version policy: warn-not-die for the upper bound

`install.sh`'s Node version check has two sides:

- **Lower bound** (`Node 20.10`) — hard fail. Node before 20.10 lacks runtime features the framework uses (specifically: `node:test`, certain `import.meta` semantics, ESM behavior). Falling below the lower bound produces a hard error with a structured remediation pointing at `nodejs.org`.
- **Upper bound** — advisory warning, not a hard fail. The framework defines a `TESTED_THROUGH_NODE_MAJOR` constant naming the highest Node major it has been exercised on. Versions above that constant produce a one-line stderr warning and continue:

> Node X.Y.Z is newer than this framework version has been tested through (Node N.x). The install will continue. If you encounter issues, please report them so the tested-through ceiling can be raised.

The constant moves forward as the framework's CI gains coverage on newer Node majors. The framework deliberately does NOT block above the constant — the original `<23` cap locked out Node 25 users for no functional reason. Real incompatibilities (when discovered) get a deny-list entry, not an upper bound.

`package.json`'s `engines.node` declaration is `">=20.10.0"` (no upper bound), so `npm install -g .` does not emit `EBADENGINE` warnings on bleeding-edge Node majors.

### MCP registration with absolute bin path

`install.sh`'s `register_mcp_in_claude_json` resolves the absolute path of `claudeagents-config-server` via `command -v` at install time and writes the absolute path into `~/.claude.json`'s `mcpServers.claudeagents-config.command` field:

```json
"claudeagents-config": {
  "command": "/opt/homebrew/bin/claudeagents-config-server",
  "args": [],
  "env": {}
}
```

(or whatever absolute path the user's npm prefix produces).

**Why this matters.** macOS GUI-launched apps (Claude Code from Dock / Spotlight / Finder) inherit a minimal PATH like `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew's `/opt/homebrew/bin/`, npm's prefix, `~/.cargo/bin/`, and shell-rc additions are absent. Registering with a bare command name (`"command": "claudeagents-config-server"`) means Claude Code's MCP launcher cannot resolve the bin and silently fails to spawn the server. The user sees `ConfigApiUnreachable` errors for the entire session, even though the bin works perfectly from any shell.

Absolute path bypasses the issue entirely. Claude Code spawns the bin directly regardless of inherited PATH.

**Resolution failure handling.** If `command -v claudeagents-config-server` returns empty at registration time, `register_mcp_in_claude_json` aborts with a structured error:

> ClaudeAgents installer: cannot resolve absolute path for `claudeagents-config-server`. The bin verification earlier should have caught this.

This is defense-in-depth — I1's post-install bin verification should have already failed with a clearer error if the bin is not on PATH. If the bin disappears between verification and registration (e.g., a third party removed it during install), this catch ensures `~/.claude.json` is not written with a stale or empty path.

**Stability of the absolute path.** The registered path is a snapshot at install time. If the user later moves their Homebrew prefix, changes their npm global location, or otherwise relocates the bin, the registration goes stale. Re-running `install.sh` rewrites the registration with the new absolute path. There is no auto-detection of bin moves; the user is expected to re-install if their global toolchain layout changes. Documented in the help text.

### What I3 does not do

- Address the install's user-facing surfaces (I2's scope: post-install message, welcome banner, permission consent flow).
- Address the install's correctness layer (I1's scope: copies-not-symlinks, `prepare` script, post-install bin verification).
- Provide automatic bin-path refresh on subsequent Claude Code launches. The registered path is set at install time; relocating the bin requires re-installing.
- Cover Windows (which has different GUI-PATH semantics; out of scope per the framework's existing platform decisions).
- Migrate users from a bare-command registration to absolute-path registration silently. The migration is "re-run `install.sh`" — the new install rewrites the registration. A user with the old registration continues to hit `ConfigApiUnreachable` until they re-install. Worth naming in release notes.

## Field encodings

I3 introduces no new schema-bearing types. The structured error codes used (`ConfigApiUnreachable` from F4 / R5; install.sh's internal error rendering) are inherited from existing specs. The `TESTED_THROUGH_NODE_MAJOR` constant is an install.sh-internal value, bumped as a maintainer task; not a runtime knob.

## Examples

The post-install MCP registration in `~/.claude.json` after I3 lands:

```json
{
  "mcpServers": {
    "claudeagents-config": {
      "command": "/opt/homebrew/bin/claudeagents-config-server",
      "args": [],
      "env": {}
    }
  }
}
```

A complete uninstall round-trip:

```
$ ./install.sh --uninstall
ClaudeAgents installer: uninstalling.

ClaudeAgents installer: uninstall complete.
  - Removed 6 framework file(s) from /Users/taa/.claude/.
  - Cleared the framework entry from /Users/taa/.claude.json (when present).
  - Removed the globally installed package `@claudeagents/config-server` (`gan` and `claudeagents-config-server` are no longer on PATH).

Restart Claude Code to remove `/gan` from the slash-command palette.

Left in place:
  - Per-project zones: `rm -rf .gan-state .gan-cache` (run from each repo) if you want them gone.
  - Project overlays under `.claude/gan/` and the once-per-machine `~/.claude.json` backup are untouched.

$ which gan
gan not found

$ which claudeagents-config-server
claudeagents-config-server not found
```

A Node version warning:

```
$ node --version
v26.0.0

$ ./install.sh
ClaudeAgents installer: prerequisites verified.
warning: Node 26.0.0 is newer than this framework version has been tested through (Node 25.x). The install will continue. If you encounter issues, please report them at https://github.com/Thomas-AppForceOne/ClaudeAgents/issues so the tested-through ceiling can be raised.

[install proceeds normally]
```

A Node version below the lower bound:

```
$ node --version
v18.19.0

$ ./install.sh
error: Node v18.19.0 is below the framework's required minimum (Node 20.10). Install Node 20.10 or newer via your package manager (for example `brew install node` on macOS, or `nvm install 20` on Linux). See https://nodejs.org/ for details.
```

## Acceptance criteria

### Automated checks

- After `./install.sh --uninstall`, `which gan` and `which claudeagents-config-server` both report "not found" (assuming `npm uninstall -g` succeeded).
- After `./install.sh --uninstall` with `npm uninstall -g` failing (simulated via stub), the filesystem cleanup completes successfully and a structured warning names the manual remediation command.
- The uninstall success message contains the post-uninstall restart hint.
- `~/.claude.json`'s `mcpServers.claudeagents-config.command` field is an absolute path after `./install.sh` completes.
- The absolute path matches the output of `command -v claudeagents-config-server` at install time.
- A simulated install where `command -v claudeagents-config-server` returns empty AT REGISTRATION TIME (after passing the bin verification) halts with the documented "cannot resolve absolute path" error.
- An install on Node above the `TESTED_THROUGH_NODE_MAJOR` constant succeeds with a stderr warning naming the user's version and the tested-through ceiling.
- An install on Node below `MIN_NODE_MAJOR_MINOR` (`20.10`) fails with the documented hard error.
- `package.json`'s `engines.node` is `">=20.10.0"` with no upper bound.
- `npm install -g .` against a Node major above the package.json engines (now no upper bound) emits no `EBADENGINE` warning.
- A re-run of `install.sh` after the user moves their Homebrew prefix produces a registration with the new absolute path.

### Manual review checks

- The Node version warning text obeys the F4 prose-discipline rule (`node` in backticks, no bare `Node` / `npm` / `MCP server` outside backticks).
- The uninstall messages name the absolute paths of removed bins so the user can verify by hand.
- The R2 spec is updated to reflect symmetric uninstall, the warn-not-die Node ceiling, and absolute-path MCP registration.
- The release notes for v1.0 name the migration step for users with stale (bare-command) MCP registrations: re-run `install.sh`.

## Dependencies

- **I1** — self-contained install correctness; I3 builds on a working install.
- **F1** — zone semantics; uninstall removes from `~/.claude/` (zone 1).
- **F4** — trust model context; absolute-path registration is part of the trusted launch posture.
- **R2** — the installer spec; I3 amends R2 in place (symmetric uninstall, version policy, absolute-path registration).
- **R5** — trust cache implementation; the `~/.claude.json` write path is shared between trust state and MCP registration.

## Bite-size note

Sprintable as:

1. (one sprint) Symmetric uninstall: add `npm uninstall -g` to `uninstall_main`, handle `npm` absent / failing, update the success message with the post-uninstall restart hint.
2. (one sprint) Node version policy: add `TESTED_THROUGH_NODE_MAJOR` constant, convert the upper-bound `die` to a `warn`, lift `package.json` engines upper bound, update help text.
3. (one sprint) MCP absolute-path registration: resolve via `command -v` in `register_mcp_in_claude_json`, update the JSON write path, add the resolution-failure error.
4. (one sprint) Test coverage: uninstall round-trip with bin removal, Node version edge cases, registration with absolute path, migration from bare-command registrations.

Slices 1–3 are independent and can land in any order. Slice 4 depends on all three.
