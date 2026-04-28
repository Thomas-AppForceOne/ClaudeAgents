# Adversarial review — second pass

Reviewer: Claude Opus 4.7 (1M context)
Date: 2026-04-27
Scope: 27 specs + roadmap, organised against REVIEW.md's seven challenge questions plus new scenarios.

Structure: each of the seven challenges, then five cascade scenarios I think the rules don't cover cleanly, then smaller architectural snags.

---

## 1. F4's trust-cache shape

**Strongest objection: the hash is the wrong unit.** F4 hashes `.claude/gan/project.md`, `.claude/gan/stacks/*.md`, `.claude/gan/modules/*.yaml` — but commands inside those files are *paths*. `lintCmd: ./scripts/my-lint.sh` makes `scripts/my-lint.sh` part of the executable surface, and the script is not in the hash. F4 acknowledges this and lets it stand. I think that's wrong:

- The threat model is "committed overlay = RCE surface." Once `[a]` is taken, the maintainer's mental model is "this hash is approved." A contributor changes `scripts/my-lint.sh` (or any other in-repo script the approved overlay invokes) and ships RCE under the existing trust. The bypass is one indirection deep and arrives by exactly the supply-chain pathway the threat model was meant to close.
- Same problem applies to `./gradlew`, `./bin/*`, and any executable inside the project root that the approved config invokes. `git diff` would catch all of these in code review; the trust hash should match `git diff`'s field of view.
- Mitigations, in declining order of cost: (a) hash-transitive — for every command path that resolves inside the project root, hash the resolved file too; (b) restrict commands to an allowlist of binaries (rejected in F4 as too inflexible — but you could allowlist by *form*: "no relative-path arg before `--`"); (c) log loudly that the trust cache only covers config files and require an explicit re-approve cadence.

**Second objection: $PATH-resolved binaries.** `./gradlew dependencyCheckAnalyze` shells out to `gradlew`, which sources `gradle/wrapper/gradle-wrapper.jar`. The .jar is also not hashed. Same class as above; flagging because (a) is harder to enforce here (the .jar is binary; transitive script hashing breaks down). Worth at least naming this in the threat model so a future spec can address it.

**Third: cache-key canonicalization is unspecified.** R5 keys on `(absolute-project-root-path, content-hash)`. No `realpath`, no case-folding for case-insensitive filesystems, no symlink resolution rule. On macOS, `/Users/Thak/x` and `/Users/thak/x` could be the same directory but two cache keys; renaming a project directory invalidates trust without content change. Pin a normalization rule in R5.

**Fourth: `getTrustDiff()` is under-specified in R5.** R5 says it returns "the per-file diff between the previous approved content and the current content." But the cache stores only the previous *hash*, not the previous *content*. So `getTrustDiff` can either (a) require storing prior content blobs in the cache (size cost, and now the cache itself is interesting to attackers) or (b) only show "current content vs nothing." R5 doesn't pick. As written, the `[v]` view-the-diff branch of the prompt has no implementation that matches the spec text.

**Fifth: cache concurrency.** R5 says writes are serialized "through the MCP server's single-writer discipline." But the MCP server is per-Claude-Code-session, and `~/.claude/gan/trust-cache.json` is global. Two terminal windows running `/gan` against two different projects on the same machine each have their own server and can race. Atomic temp-file + rename mitigates corruption but not lost-update. Worth specifying the cache as append-only-with-flock, or accepting last-write-wins explicitly.

**Sixth: `approved-hashes-only` has no documented onboarding for CI.** "Cache must be present in the CI runner's filesystem" — how? Bake into the image? Commit a copy somewhere? Without a spec'd pattern, every team will reach for `unsafe-trust-all`. Either spec a "trust manifest" file that lives in the repo and is consulted in CI mode, or accept that `approved-hashes-only` is a power-user mode that won't be the common path.

**On the [v]/[a]/[r]/[c] prompt:** the prose is fine; what matters is whether the diff in `[v]` is actually computable (see fourth point above). The mode names are clear; defaults are right.

## 2. E3 deterministic-core honesty

**Main worry: the harness inputs are smaller than what the runtime evaluator processes.** The deterministic core takes "snapshot + sprint plan + worktree state." In production, the evaluator also sees the *generator's diff* and decides which surfaces apply against post-diff content. C1's keyword-trigger algorithm explicitly says "search the touched files (existing content **+ proposed diffs if available**)." E3's harness exercises pre-diff state only (it has no generator output). So:

- The harness validates "given a sprint plan, what would the evaluator decide *before* the generator runs?" That is **not** what the runtime evaluator decides. A regression in post-diff keyword matching (e.g. a glob library quirk on a path with brackets) would slip past the harness.
- The fix is either (a) generate a synthetic post-diff state in fixtures, or (b) call the harness's claim what it is — it tests the *pre-diff* deterministic pipeline, not "the deterministic core of the evaluator." The latter framing oversells.

**Glob library is unpinned.** "Deterministic" only holds if `picomatch` vs `minimatch` vs `node-glob` produce identical results — they don't, on dotfiles, escapes, brace expansion. E3 doesn't name the library. Pin it; cite the version. Otherwise "deterministic" is a per-machine claim.

**`securitySurfacesInstantiated.appliesToFiles` is deterministic *given* the planner's output, but the planner is an LLM.** The harness sidesteps this with synthetic `sprint-plan.json`. Fair. But the carve-out's claim is broader than what the harness tests — it tests "core is deterministic given fixed plan," not "evaluator is deterministic." Production evaluator inherits planner variance through `appliesToFiles`. Worth saying so plainly.

**Future scope drift.** Today every `securitySurfaces` decision is keyword + glob. Tomorrow, if any surface needs LLM-aided semantic detection ("this diff introduces *intent* to expose data"), it can't live in the deterministic core. The harness would still claim coverage of "the deterministic pipeline" but the pipeline's surface area would be shrinking. Recommend: gate any new `securitySurfaces` trigger type on the question "is this expressible as a pure function?" — so the carve-out doesn't quietly erode.

## 3. F2's per-call `projectRoot`

I think per-call is right on the merits, and you wouldn't regret it under future MCP session-state primitives — explicit args are easy to wrap with a session-bound shorthand later, hard to back out of. Two real concerns:

- **No path canonicalization rule.** F2 says "absolute path" only. Trailing slash, symlink, case-folding, double-slashes — all currently caller's problem. Pin `realpath`-equivalent at API boundary; otherwise `getResolvedConfig("/x/proj")` and `getResolvedConfig("/x/proj/")` could differ in trust state.
- **No capability binding.** Any caller can pass any `projectRoot`. The trust model assumes orchestrator-controlled values. If an agent ever surfaces a user-influenced string into a `projectRoot` argument (e.g. via a future "operate on this subtree" feature, or any tool-injection vector), the API will dutifully resolve and approve. There's no signed token. For pre-1.0 this is acceptable; flag it for the post-R audit so it's explicit.

R3's CLI defaults `--project-root` to cwd. For `gan validate` that's fine; for `gan trust approve` that's a small footgun ("approved the wrong project from the wrong directory"). Recommend requiring an explicit flag for trust-mutating commands.

## 4. C3 splice-point catalog stability

Consolidation into one C3 table is the right move. The catalog covers replace, deep-merge, union, scalar-override, project-only — and doesn't cover anything more exotic. Two real future-proofing concerns:

- **Cross-splice-point dependencies.** A rule like "use stack X's threshold unless stack Y is also active" is currently inexpressible — every splice point resolves independently. No need today; modules are likely the first place it'd arise (M2's portRegistry depends on the worktree, but that's run state, not config). Worth stating the design assumption *out loud* in C3: "splice points resolve independently; cross-point logic is out of scope."
- **`evaluator.additionalChecks` execution ordering interacts subtly with duplicate-key positioning.** C4 says "merge order = execution order, lower-tier first," and "duplicate-key override takes the lower-tier slot's position." So a project-tier override of a user check executes at the *user's* position. Worked example would help: user has checks `[A, B, C]`; project overrides `B` and adds `D`. Final list/exec order: `[A, B', C, D]`. That's defensible (project's override "stays in B's slot") but most users would expect the override to feel "later" than the user's. If the intent is that a project override is *equivalent* to the user's check, document that "override is in-place, not append" with a worked example in C4.

## 5. Phase ordering / four revision breaks

The four breaks are well-placed. Two adjustments to consider:

- **No explicit checkpoint between R5 (trust cache impl) and U1/U2 (overlay UX shipping to users).** R5 is the security backbone; U1/U2 are when committed overlays go mainstream. The post-R audit covers F2 and C-specs but doesn't single out F4/R5. If R5's prompt UX or `getTrustDiff` implementation has rough edges discovered late, U1 ships into users' hands telling them to commit overlays before trust is operationally mature. Either fold an explicit F4/R5 check into the post-R audit or add a tiny pre-U1 gate ("R5's prompt + diff has been exercised against real PRs").
- **O1 lands in Phase 6, after S1–S3.** O1 is the user's debugging surface (`gan config print`, startup log). An Android dev hitting an S1 detection bug in Phase 5 has no observability tool. Either move O1 forward to before S1, or carve the minimum viable observability (startup log alone) into R1 and leave the richer surfaces for Phase 6. The post-S audit will be easier with O1 already in users' hands.

The four breaks are not theatre — each is gated by a meaningful event (R impls land, E1 lands, M2 lands, S-stacks land). Don't relax discipline.

## 6. Runtime boundary under F4

I checked F4 / R5 surfaces for Node-shaped leaks:

- **Error texts.** `TrustCacheCorrupt` "directs the user to inspect or delete it." If the actual message is `rm ~/.claude/gan/trust-cache.json`, that's shell — fine. Pin the exact text to avoid drift; an iOS dev reading "run `npm run trust-reset`" would be a leak.
- **`GAN_TRUST` env var modes.** Names are reasonable. Documentation that explains the modes shouldn't say "the Node MCP server reads…"; it should say "the framework reads…". Same pattern needed everywhere `GAN_TRUST` is documented. R5 currently slips here in its log-line example (`[gan-config-server]` is OK because that's the running process; just don't put `node` in the user-facing error text).
- **Symlink/path-escape semantics.** F4 says "Symlinks are followed for the existence check but the resolved real path must still be inside the project root." Behavior of realpath on Windows junctions, on broken symlinks, and on case-insensitive filesystems is unspecified. iOS dev on macOS is fine; Windows-host dev is in undefined territory. Pin the rule (probably "use Node's `fs.realpathSync.native` and reject if path is not a descendant by string-prefix after both sides are normalized" — but state it).

The trust cache itself living at `~/.claude/gan/trust-cache.json` is technically a Node-managed file but is shaped like config — fine. The CLI surface (`gan trust approve`) routes through R3 (Node), but a Swift dev hitting `[a]` in the prompt never types a Node command — they just press a key. That's the right design.

## 7. Cascade scenarios — five I'd push on

**a) `discardInherited` + scalar inherit — does it reset to default or to empty?**
User overlay sets `runner.thresholdOverride: 8`. Project overlay sets `runner.discardInherited: true` with no `thresholdOverride`. C4's example says result = "agent's baked-in default threshold." But the rule says "discard upstream merge input before applying this level's values." Default-tier values are below user, so the merge input *to* the project step is the user-resolved view (default ⊕ user). After discard, that's empty. Project applies nothing. Result should be empty / undefined — but the spec example says "default." There's a hidden rule: "fall back to bare default after discard." State it.

**b) Two active stacks declaring `securitySurfaces` with the same `id`.** C1 keys surfaces by `id` *within* a stack; C2 says scope-filter cross-stack. Cross-stack `id` collision (`android.exported_components` and `kotlin.exported_components`) isn't specified. The contract-proposer instantiates from active stacks — does it dedup by id, by template text, or surface both? Likely you want "namespace by stack name" (so `<stack>.<id>` is the key). Pin it.

**c) Project-tier stack file shadowing + `pairsWith.consistency`.** A user shadows `stacks/docker.md` at `.claude/gan/stacks/docker.md` per C5 (wholesale replacement). They omit `pairsWith: docker`. The module's `pairsWith.consistency` invariant per F3 fires — `validateAll()` fails. The user is now forced to know about pairsWith just to shadow a stack file. UX hole — recommend the lint/error message on this case explicitly say "your project-tier stack file shadows the module-paired default; either re-declare `pairsWith: docker` or rename your file."

**d) `stack.cacheEnvOverride` only partially resolves the conflict.** Stack A and Stack B both declare `GRADLE_USER_HOME` with different `valueTemplate`. User adds `cacheEnvOverride.A.GRADLE_USER_HOME: <new>`. C1 says "if present, the override wins and no error is raised." But Stack B's value is still different from the new A value. So the conflict persists between (overridden-A, unchanged-B). The "no error is raised" line is too generous — the override resolves the conflict only if both stacks are also overridden, *or* if the override value happens to match Stack B's. Pin the rule: either require overriding all conflicting stacks, or require the user to set the overriding value to match every conflicting stack, or accept the conflict only if overrides cover all sides. Currently ambiguous.

**e) Snapshot freshness "may re-snapshot" after agent writes.** F2: "when an agent writes via the API, the orchestrator **may** re-snapshot before spawning the next agent." E1: same wording. "May" is a footgun: in a deterministic system, sometimes-the-next-agent-sees-it and sometimes-not is not a sound semantics. Either always re-snapshot after a write (cheap; one more `getResolvedConfig` per write) or never (writes during a run never affect the run that wrote them; user must re-invoke). Don't leave it as "may." If the answer is "always after writes that change splice-point-relevant state, never for module state," spell that out — but please pick one.

## Smaller architectural snags

- **Schema bump tax in pre-1.0.** F3 says "exact match required, no compat ranges." Every Claude Code update that bumps `@claudeagents/config-server` with a schema change forces every committed `.claude/gan/project.md` to be re-saved with the new `schemaVersion`. Across all repos a maintainer touches. Bake migration tooling now (`gan migrate-overlays --to=N`) — the cost is low while there are few real schemaVersions, and the user-facing pain of "your overlay broke" deferred until later will be much worse.
- **MCP and dynamic tool registration.** M1's `registerModule()` records modules in API state but MCP doesn't generally support dynamic tool registration mid-session. Reads/writes to module state route through the existing `getModuleState`/`setModuleState` tools, keyed by module name — that's correct. But this isn't stated; a reader could come away thinking each module exposes its own MCP tools. Add one line to F2 or M1.
- **`additionalContext` is not stack-scoped.** A project that's polyglot (Android + Python) lists planner additionalContext globally. There's no way to say "load `architecture.md` only when planning for the Android stack." Today: minor. As polyglot fixtures get richer (your `polyglot-android-node` fixture), this will bite.
- **Trust cache stores notes.** R5 includes an optional `note` at approval time. Users will paste secrets into notes ("approved per ticket SEC-419"). Worth spec'ing that the cache file is mode 600.
- **`/gan --no-project-commands` falls back from tier-1/2 to tier-3 commands** — but only if a tier-3 file with the matching stack name exists. For a custom stack at tier 1 with no tier-3 fallback, the stack is "treated as not-defined." That's correct, but the user reviewing someone's PR who picked `[r]` will see "your custom stacks didn't run" and may not know what they missed. R5's startup log lists what was suppressed — make sure that includes "custom stacks XYZ entirely skipped (no tier-3 fallback)," not just "the following commands were skipped."

---

## Summary

The architecture is in much better shape than first-pass. F4 + R5 close the right threat. The biggest remaining hole is **the trust cache's blast radius is narrower than the threat surface**: it covers config files but not the scripts they invoke. That gap deserves a named, accepted position in F4 (not "currently no") — either fix it or document why "approve once, then re-review every PR's script changes" is the user's actual workflow under this design.

The deterministic-core carve-out is honest about *itself* but mis-titled relative to what the runtime evaluator does; harness-input scope (pre-diff vs post-diff) is the real disclosure.

Phase ordering is sound. Add an F4/R5 operational gate before U1, or fold it explicitly into the post-R audit.
