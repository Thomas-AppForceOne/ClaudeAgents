# ClaudeAgents — Roadmap

Ordered list of specs. Order reflects **value-for-effort first**, respecting dependencies. Each spec is individually shippable and testable.

## Phase 1 — Quick wins (no architectural change)

Small, additive patches. Each one makes the existing pipeline work better on more stacks without touching agent structure. Ship these first — they deliver value immediately and are independent of the later refactor.

1. [01-kotlin-secrets-glob.md](01-kotlin-secrets-glob.md) — Add `.kt`, `.kts`, `.gradle.kts` to the evaluator's secrets grep.
2. [02-gradle-dependency-audit.md](02-gradle-dependency-audit.md) — Add a Gradle branch to the evaluator's dependency audit step.
3. [03-worktree-build-cache-isolation.md](03-worktree-build-cache-isolation.md) — Give each run worktree its own build cache to avoid daemon/lockfile conflicts.

## Phase 1.5 — Filesystem layout (foundation)

Pins the three-zone project filesystem (config / state / cache) before any stateful tool lands. Prerequisite for the MODULES_ARCHITECTURE.md port-registry relocation and for every later spec that writes files under a project root.

14. [14-gan-filesystem-layout.md](14-gan-filesystem-layout.md) — `.claude/gan/` (config), `.gan-state/` (durable state), `.gan-cache/` (ephemeral cache). Retires today's single-purpose `.gan/` directory and assigns each zone a single lifecycle owner.

## Phase 2 — Stack-plugin refactor (foundation)

Separates *orchestration* from *stack mechanics* so new stacks become a file drop, not an agent rewrite. Everything after this phase depends on it.

4. [04-stack-plugin-schema.md](04-stack-plugin-schema.md) — Define the `stacks/<name>.md` file format.
5. [05-stack-detection-and-dispatch.md](05-stack-detection-and-dispatch.md) — Agents detect the stack and load the matching file.
6. [06-extract-builtin-stacks.md](06-extract-builtin-stacks.md) — Move the existing web/node, python, rust, go logic out of agent prompts into stack files.

## Phase 3 — New stacks

7. [07-android-stack.md](07-android-stack.md) — Android client stack file.
8. [08-kmp-stack.md](08-kmp-stack.md) — Kotlin Multiplatform stack file (depends on 07 for shared Kotlin pieces).

## Phase 4 — Overlays (project and user customisation)

Lets users add context and criteria without forking agents. Kept strictly generic — ClaudeAgents owns the file paths and schemas; it never assumes anything about other tools' conventions.

9. [09-project-overlay.md](09-project-overlay.md) — `.claude/gan/project.md` with a minimal set of splice points.
10. [10-additional-context-splice.md](10-additional-context-splice.md) — Overlay points the planner at arbitrary project docs.
11. [11-user-overlay.md](11-user-overlay.md) — `~/.claude/gan/config.md` for cross-project personal defaults.
12. [12-three-tier-stack-resolution.md](12-three-tier-stack-resolution.md) — Resolve `stacks/<name>.md` in order: project → user → repo.

## Phase 5 — Observability

13. [13-resolution-observability.md](13-resolution-observability.md) — Log which files were loaded at startup; `--print-config` flag to inspect resolved config without running a sprint.

## Ordering rationale

- **Phase 1** ships before refactor because the fixes are tiny, orthogonal, and benefit every project today. Deferring them behind the refactor delays value.
- **Phase 1.5** (spec 14) is placed before Phase 2 because it resolves a real directory collision between MODULES_ARCHITECTURE.md and the `/gan` skill. It is independent of the stack-plugin work but benefits every later spec that writes project-level files.
- **Phase 2** is a prerequisite for Phases 3 and 4.
- **Phase 3** proves the plugin system by adding the first new stacks.
- **Phase 4** is listed after stacks because the overlay's most useful splice point (`stack.override`) only makes sense once stacks exist as a concept.
- **Phase 5** is last because it describes state that only becomes complex once Phase 4 resolution is in place.

## Relationship to MODULES_ARCHITECTURE.md

`MODULES_ARCHITECTURE.md` and this roadmap describe **two different extensibility layers** that coexist without overlap:

- **Modules** (`src/modules/<name>/`) are *runtime utility libraries* — imperative JavaScript code that agents `require()` at execution time (e.g. `claudeagents/modules/docker` for port discovery and container health checks). They solve "how do I do the thing" problems.
- **Stacks** (`stacks/<name>.md`, this roadmap) are *declarative agent configuration* — markdown files that tell agents which files to scan, which commands to run, and which security surfaces to check. They solve "what should the agents do for this tech stack" problems.

A single tech stack may have both (e.g. a future `docker` stack file declaring detection and security surfaces, paired with the existing `modules/docker` runtime utilities) or only one. Neither layer subsumes the other.

**Filesystem boundaries between the layers are formalised in [spec 14](14-gan-filesystem-layout.md).** In particular, modules that persist state across runs (e.g. the Docker port registry) must write to `.gan-state/modules/<name>/`, not to `.gan/` — the latter is retired by spec 14 in favour of zone-scoped directories with single-owner lifecycles.

### Runtime boundary: maintainer tooling vs. user-facing behavior

ClaudeAgents targets developers in every ecosystem — Swift/iOS, C++/embedded, Rust, Go, Kotlin/Android, Python, JS, and whatever comes next. Forcing a Node runtime onto an iOS developer who only wants `/gan` to understand their Xcode project would break that promise. The RFC therefore splits tooling by who runs it:

- **Maintainer tooling** (spec 04's stack-file lint script, spec 06's capability-check harness, any other script that runs in ClaudeAgents' own CI or on a contributor's machine) **may assume Node 18+**, since MODULES_ARCHITECTURE.md already establishes Node as the maintainer runtime. These scripts never run on a user's machine.
- **User-facing behavior** (reading stacks, applying overlays, resolving the three-tier cascade, producing `--print-config` output, emitting validation errors on malformed input) **is owned by the agent at runtime**. The agent parses YAML, applies the cascade, and reports errors using its own execution context. No additional runtime is required on the user's machine beyond Claude Code itself.

Specs remain runtime-neutral: the schema in spec 04 is a language-neutral JSON Schema; the capability-check format in spec 06 is a documented format. The Node scripts that ClaudeAgents ships are the reference implementation, not a requirement. A third party can implement alternative tooling in Swift, Rust, Python, or shell without rewriting specs.

User-facing agent output (error messages, suggestions, dry-run reports) must never reference a maintainer-only script by name. If a stack file is malformed during a `/gan` run, the agent reports the structural problem directly — it does not tell the user to run `npm run lint-stacks`.

## Out of scope for this roadmap

- Cross-run learning / auto-curated project memory. `/gan` stays a reader of documented overlay files; it never writes durable project knowledge. Curation belongs to whatever agent a user chooses to run outside ClaudeAgents.
- Reading arbitrary repo files (README, ARCHITECTURE, etc.) by auto-discovery. Users opt in explicitly via `additionalContext` (spec 10).
- iOS, desktop, embedded stacks. Follow the Android/KMP template once it's proven; not roadmapped here.
