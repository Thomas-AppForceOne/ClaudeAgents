# C5 — Three-tier stack file resolution

## Problem

Even with the stack plugin system (C1/C2) and overlays (C3/C4), a user may need to **customise a stack itself** for one project — tighten the Android `securitySurfaces` catalog with company-specific rules, point a `buildCmd` at an in-house wrapper. Without per-tier resolution, stack content can only be changed by editing the framework repo.

## Proposed change

Extend stack-file resolution to three tiers, highest priority first. The tier labels (`project`, `user`, `builtin`) are the canonical names used in code, in `getStackResolution()` output, and in CLI-visible provenance. Earlier drafts of this spec used "tier 1/2/3" or "project/user/repo"; those forms are retired in favour of the consistent set below.

1. **`project` tier** — `<projectRoot>/.claude/gan/stacks/<name>.md`. Zone 1 (config) per [spec F1](F1-filesystem-layout.md); user-authored and committed.
2. **`user` tier** — `~/.claude/gan/stacks/<name>.md`. User-personal; outside any project.
3. **`builtin` tier** — `<repo>/stacks/<name>.md`. Built-in defaults shipped with ClaudeAgents. (The exact path the resolver uses to find these files is the subject of a downstream revision documented in C5's "Built-in tier path resolution" section, which lands with the resolver-change sprint; the three-tier mechanics in the rest of this spec are agnostic to that path.)

The resolution runs **inside the Configuration API** (F2) — specifically inside R1's stack loader. Agents call `getStack()` / `getActiveStacks()` and receive the resolved file's data; they never enumerate tiers themselves.

Resolution rules:

- For each **active stack name** (per C2's detection algorithm), the API serves the file from the highest-priority tier that contains it.
- A project tier file **replaces** the lower-tier file for that stack — no partial merging. Replacement is coarse but predictable; users who want additive behavior should use overlays (C3), not shadow the stack file.
- **Replacement is wholesale.** A project-tier `stacks/docker.md` that omits a `pairsWith` declaration drops the pairing — even if the repo-tier file declared one. If the user wants the pairing preserved, they must re-declare `pairsWith` in their project-tier file. The `pairs-with.js` invariant fires on any inconsistency between the resolved (highest-priority) stack file's `pairsWith` and the corresponding module's manifest. **The error message must include a remediation hint** when this exact case fires (project-tier file shadows a module-paired default but omits `pairsWith`):

> `pairs-with.consistency: project-tier stack file ".claude/gan/stacks/docker.md" shadows the canonical "stacks/docker.md" but does not declare pairsWith. The docker module shipped by ClaudeAgents expects this stack file to declare pairsWith: docker. Either re-declare pairsWith: docker at the top of your project-tier file, or rename your file (e.g. .claude/gan/stacks/my-docker-variant.md) and force its activation via stack.override in your project overlay.`

The user should not need to learn the `pairsWith` mechanism to shadow a stack file; the error names the fix.
- `schemaVersion` in the stack file frontmatter must exactly match the API's known stack schema version; mismatch is a hard `SchemaMismatch` error.
- The API records which tier each active stack came from and exposes it via `getResolvedConfig()` for O1's observability surface.

Detection rules live only in the `builtin` tier for v1 — `project` and `user` tiers can override a stack's contents but not introduce new detection patterns. This keeps the detection surface auditable. If a user needs a completely new stack, they put a file in a customisation tier (`project` or `user`) and force it via `stack.override` (from spec C3).

## Why wholesale replacement (and how to avoid forking)

Stack files **replace**; overlays **merge**. The asymmetry is not accidental — it falls out of what each artifact contains.

A stack file is structurally rich: composite `detection` rules (`allOf` / `anyOf` trees), `scope` glob lists, `securitySurfaces` arrays with keyword + glob triggers, command shapes with `absenceSignal` modes. There is no good answer to "what does it mean to merge two `detection.allOf` composites?" or "merge two `securitySurfaces` lists with overlapping ids?" Any merge semantics we picked would surprise users in some plausible case, and the surprises would be silent. Wholesale replacement is loud: when you fork, you own the whole file. When something breaks, the cause is one place.

Overlays are deliberately the opposite: every overlay splice point is a **single, narrow customisation slot** with a documented merge rule (per C3's catalog). Splice points exist precisely so users do not need to fork stack files to make small customisations.

### Boundary rule: when to use overlay splice points vs. when to fork

The honest rule, future-proof against C3's catalog growing:

- **Use overlay splice points** when a splice point exists for what you want to change. Today that includes additive surfaces and criteria via `proposer.additionalCriteria`, surface suppression via `proposer.suppressSurfaces`, env-value tweaks via `stack.cacheEnvOverride`, additional commands via `evaluator.additionalChecks`, and others. **The catalog in [C3](C3-overlay-schema.md) is the authoritative list** — when C3 grows, the "must fork" surface narrows automatically.
- **Fork the stack file wholesale** when no splice point covers your need. This always includes anything that affects which-stack-fires (the `detection` block — and per F3's `detection.tier3_only` invariant, forking detection is in fact the *only* way to change activation rules at all) and the `scope` block. It also covers structural command fields (`buildCmd`, `testCmd`, `lintCmd`) and anything else not enumerated in C3's catalog.

The dominant case for forking is exactly the first bucket — changing detection or scope to fit a project the framework's canonical stack file doesn't quite match. The dominant case for *not* forking is "I want one extra surface" or "I want to suppress one surface" — both of which have splice points and should never require touching a stack file.

### Worked example — "I want one extra criterion"

A team using `stacks/web-node.md` wants an additional proposer criterion: every PR introducing a new GraphQL resolver must declare its rate-limit budget. The wrong path:

```yaml
# .claude/gan/stacks/web-node.md  ← DO NOT do this
# (forks the entire web-node stack file just to add one surface;
#  loses upstream improvements to the canonical web-node, hits the
#  pairsWith footgun, has to maintain detection / scope / buildCmd /
#  testCmd / lintCmd / every other surface in lockstep with upstream)
```

The right path:

```yaml
# .claude/gan/project.md
proposer:
  additionalCriteria:
    - name: graphql_rate_limit_declared
      description: Every new GraphQL resolver must declare its rate-limit budget.
      threshold: 9
```

One splice point, one line of intent, automatic merge with the canonical web-node stack, automatic propagation when upstream improves the canonical file. The user never touched a stack file.

### Worked example — "I want to suppress one surface"

The same team finds that web-node's `untrusted_input_in_template` surface fires too noisily for their codebase (every PR that touches a JSX template hits the keyword scan, even when input is statically a string literal). Right path:

```yaml
# .claude/gan/project.md
proposer:
  suppressSurfaces:
    - web-node.untrusted_input_in_template
```

The forking path would have been ten times the code, with all the maintenance burden a fork carries. The boundary rule sends the user to the small-customisation slot where a small customisation belongs.

## Acceptance criteria

- Dropping `.claude/gan/stacks/android.md` in a project causes that file to be loaded instead of the repo's `stacks/android.md`, verifiable via the observability output from spec O1.
- A user-level stack file is loaded when no project-level file exists and no repo-level file exists for that name.
- A `schemaVersion` mismatch produces a hard error naming the offending file and the expected version.
- Removing the project-level file restores repo defaults without further action.

## Dependencies

- C1, C2 (the dispatch algorithm whose results this resolves)
- C3 (for `stack.override` interaction), C4 (for the user tier)
- F2 (resolution runs inside the API)

R1 implements the resolution; the dependency runs from R1 to C5, not the reverse.

## Bite-size note

One resolver function inside R1's stack loader. Sprintable in three slices: tier enumeration → project-replaces-lower replacement logic → tier provenance reporting for O1. Each is independently testable against fixtures with stack files at varying tiers.
