# R6 — Tier-aware stack scaffold

## Problem

The first-use scaffold path has a trap that survives the user doing everything right.

`gan stacks new <name>` writes a project-tier stack file to `<root>/.claude/gan/stacks/<name>.md` — and project tier is the only tier the command accepts (`--tier=user` is rejected today). The scaffold body emitted by `buildScaffold()` always contains a `detection:` block with a TODO placeholder, alongside the DRAFT banner and the other TODO stubs.

The DRAFT banner and the command/scope/secrets TODO stubs are *intentionally* invalidating: they make `gan validate` fail until the user has done their first edit pass (replace the TODOs, remove the banner). That is the designed "you're not done yet" signal and R6 does not touch it.

The `detection:` block is different. Per **[C5](C5-stack-file-resolution.md)** ("Detection rules live only in the `builtin` tier for v1") and the **[F3](F3-schema-authority.md)** cross-file invariant `detection.tier3_only`, a `detection` block in a **project-tier or user-tier** stack file is a hard `InvariantViolation` — and C1's schema additionally rejects it at parse time. The scaffold tells the user to fill that block in. A user who scaffolds, replaces every TODO including the detection marker, and removes the DRAFT banner — i.e. follows the scaffold's own written instructions exactly — is left with a file that *still* fails `gan validate`, on a rule the scaffold itself led them into. The dogfooding session hit this. There is no edit the user can make to the scaffolded `detection:` block that produces a valid project-tier file; the only fix is deleting the block, which the scaffold never tells them to do.

**[R3](R3-cli-wrapper.md)** line 70 already states the intended behaviour — "The scaffold is tier-aware … emits different content for `--tier=project` vs. `--tier=user`" — but the shipped implementation neither supports `--tier=user` nor varies the body by tier. R3 is a shipped spec and is immutable; R6 is the spec that actually delivers the tier-aware scaffold R3 described, with the roadmap as the cross-reference layer. R6 is the sixth spec under the **R** (reference implementation) phase code; it lands in `src/cli/` and authors no new Config API surface.

## Proposed change

### The scaffold body is detection-free at project and user tiers

`buildScaffold()` becomes tier-aware. For the `project` and `user` tiers — the only tiers `gan stacks new` writes to — the emitted body **does not contain a `detection:` block at all**. In its place the scaffold emits a comment block explaining *why* there is no detection and how the stack actually activates at this tier (see next subsection).

Every other stubbed field is unchanged: `name`, `schemaVersion`, `scope`, `buildCmd`, `testCmd`, `lintCmd`, `auditCmd`, `secretsGlob`, `securitySurfaces`, the DRAFT banner, the second-line CI warning, and the `## Conventions` prose. `scope` stays a TODO stub: it is valid at project tier (only `detection` is `tier3_only`), and a forked stack still needs its scope declared.

The contract R6 establishes: **after the documented first-edit pass (replace every TODO, remove the DRAFT banner), a scaffolded project-tier or user-tier file passes `gan validate` with zero residual structural invariants.** No `detection.tier3_only`, no C1 parse rejection. The only thing standing between a fresh scaffold and a valid file is the work the scaffold explicitly asks for — nothing hidden.

### The scaffold explains tier-tier activation in place of detection

A project- or user-tier stack file does not auto-activate by detection (detection is builtin-tier only). It activates one of two ways, per C5 / C3:

1. **Same-name shadow** — the file's `name:` matches a builtin stack name; the project/user-tier file then *replaces* that builtin stack's content wholesale when the builtin stack's detection fires.
2. **Forced activation** — a brand-new stack name that no builtin defines is activated by listing it in `stack.override` in the project (or user-resolved) overlay.

The detection-shaped comment block the scaffold emits states both paths explicitly, names the `stack.override` overlay field, and notes that without one of the two the stack will never be active. It also states that `stack.override` is a **replacement, not an addition** — listing only this stack suppresses every auto-detected stack including the `generic` fallback — and tells the user to list `generic` (and any other stack they want kept) alongside their stack name if they want fallback semantics. This wording is deliberately kept consistent with **[W1](W1-overlay-misuse-warnings.md)**'s `StackOverrideShrinkage` remediation text so a first-use author following the scaffold's guidance does not walk straight into a W1 warning with no context: the scaffold says up front what W1 would otherwise have to warn about after the fact. This is the "tier-aware" content: a builtin-tier author needs `detection:`; a project/user-tier author needs to know detection is unavailable, what to do instead, and that the override is wholesale. The scaffold now tells them at the exact spot they would otherwise have typed a doomed `detection:` block.

### `--tier=user` is supported

`gan stacks new <name> --tier=user` writes to `~/.claude/gan/stacks/<name>.md` (the user-tier path per C5). Both `project` (default) and `user` are accepted; any other value — including the legacy `repo`, `builtin`, and unknown strings — keeps the existing structured `MalformedInput` rejection, with the message updated to name both supported values (`project`, `user`).

Project and user tier emit the **same detection-free body**; the activation-comment wording is identical except for naming the tier and its overlay (project overlay vs. user overlay) in the `stack.override` hint. There is no end-user `builtin`/`repo` scaffold target — built-in stacks ship inside the published npm package and are surfaced via `gan stacks customize` (unchanged from R3).

### Coordination with in-flight (Draft) specs

R6 references R3/C5/F3/C1 as shipped, immutable upstream contracts. Three specs are still **Draft** and share R6's surface; R6 coordinates with them so they ship a consistent v1.0 story without any of them editing another:

- **D1 (Draft; roadmap slot 13 — ships *after* R6 at slot 6) — D1 must be updated for R6.** CLI help is centralised in `src/cli/lib/help.ts`; there is no separate per-subcommand usage string. The shipped help block for `gan stacks` *already* advertises `--tier=project|user   Where to scaffold/customize/reset (default: project).` (and a `--force` line). This is the pre-existing incoherence R6 closes from the code side: the help promised user-tier scaffold while `gan stacks new` rejected `--tier=user`. **R6 therefore adds no new help text** — it makes the behaviour match help that already exists. D1 authoritatively rewrites this same `gan stacks --help` block, and its current draft of that block **omits the `--tier` / `--force` options section**. If D1 shipped as-drafted after R6, it would regress the help by deleting the `--tier=project|user` documentation R6 just made truthful. Per the spec-lifecycle rule, the fix folds into the unimplemented spec: **D1's quoted help block and its acceptance criteria must retain an options section documenting `--tier=project|user` (default `project`).** This R6 spec is the cross-reference that records *why* that line must survive D1's rewrite; D1 owns the help text itself. (Editing D1 is permitted — D1 is Draft, not shipped.)
- **W1 (Draft).** R6's scaffold guidance about `stack.override` is intentionally worded to match W1's `StackOverrideShrinkage` remediation (see "The scaffold explains tier-tier activation" above). R6 is the proactive surface (tell the author before they author); W1 is the reactive surface (warn if they got it wrong anyway). They are complementary, not duplicative; neither edits the other.
- **O1 (Draft).** O1's `getActiveStacks` snapshot uses the canonical tier labels `project` / `user` / `builtin` (per C5). R6 uses the same set in `--tier`, the success message, and the scaffold comment. No change to either spec — recorded so the vocabulary is verifiably aligned across the in-flight set.

Overlay-authoring UX depth (how to write `stack.override`, `discardInherited` interaction) is owned by **U1** (project overlay) and **U2** (user overlay), both Draft. R6's scaffold comment gives the minimum actionable pointer and deliberately does not duplicate U1/U2's authoring guidance.

### What R6 does not change

- The DRAFT-banner invariant, the second-line CI warning, and the command/scope/secrets TODO stubs. They stay invalidating-by-design; R6 only removes the *detection* trap, not the intentional "finish me" friction.
- The scaffold-no-overwrite rule (R3-locked; no `--force`).
- `atomicWriteFile` persistence, byte-for-byte determinism of `buildScaffold()`, exit-code routing through `lib/exit-codes.ts`.
- C5's tier model, F3's invariant catalog, C1's schema. R6 produces files that *comply* with them; it does not edit those shipped specs.

## Field encodings

R6 introduces no new schema-bearing types and no new runtime knobs. `runtime-knobs.md` gains nothing. The tier→body selection is an internal `buildScaffold(name, tier)` argument; the only externally visible surface change is `--tier=user` becoming an accepted value of an already-documented flag.

## Examples

### Project-tier scaffold, after R6

`gan stacks new acme-svc` writes (DRAFT banner + second line elided):

```
---
schemaVersion: 1
name: acme-svc
# This stack is project-tier: it cannot declare `detection:` (that is
# builtin-tier only — see C5 / F3 detection.tier3_only). It activates by
# EITHER naming a builtin stack (same `name:` shadows/replaces it when that
# stack's detection fires) OR being forced via `stack.override` in your
# project overlay (.claude/gan/project.md). Without one of those, this
# stack never becomes active. `stack.override` REPLACES auto-detection
# wholesale — it is not additive. If you list only this stack you suppress
# every detected stack and the `generic` fallback; list `generic` and any
# other stack you want to keep alongside this one.
# TODO: replace the scope globs so stack-scoped commands run only on
# files this ecosystem owns.
scope:
  - "TODO/**/*"
buildCmd: "false  # TODO: replace before committing — your build command"
...
securitySurfaces: []
---

## Conventions
...
```

After the user replaces the TODOs and deletes the DRAFT banner, `gan validate` passes. Before R6 the same sequence still failed on `detection.tier3_only`.

### `--tier=user`

```
$ gan stacks new my-rust --tier=user
Scaffolded stack `my-rust` at /Users/me/.claude/gan/stacks/my-rust.md (tier: user).
Replace the TODOs and remove the DRAFT banner before committing.
```

The body is identical to the project-tier body except the activation comment names the user overlay for the `stack.override` path.

### Rejected tier (unchanged behaviour, updated message)

```
$ gan stacks new x --tier=repo
Error: --tier must be 'project' or 'user' (got 'repo').
```

## Acceptance criteria

### Automated checks

- `buildScaffold(name, 'project')` and `buildScaffold(name, 'user')` emit **no** `detection:` key. A test parses the scaffold YAML frontmatter and asserts `detection` is absent.
- Taking a scaffolded project-tier file, programmatically replacing every `TODO`-marked value with a schema-valid stub and removing the DRAFT banner, then running `validateStack` / `gan validate` on it, yields **zero** errors — specifically no `detection.tier3_only` `InvariantViolation` and no C1 parse rejection. Same assertion for `--tier=user`.
- `gan stacks new <name> --tier=user` writes to `~/.claude/gan/stacks/<name>.md` (user-tier path per C5), atomically, byte-for-byte equal to `buildScaffold(name, 'user')`.
- `gan stacks new <name>` with no `--tier` still writes the project-tier path; default behaviour is unchanged except for the now-absent `detection:` block.
- `--tier` with any value other than `project` / `user` exits `EXIT_BAD_ARGS` with a structured `MalformedInput` whose message names both supported values.
- `buildScaffold` remains pure and deterministic: same `(name, tier)` ⇒ byte-identical output across runs.
- The scaffold still contains the DRAFT banner, the second-line CI warning, and the command/scope/secrets TODO stubs (R6 does not remove the intentional friction). A test asserts `gan validate` on the *un-edited* scaffold still fails (on the banner + TODO stubs), proving R6 narrowed the failure set rather than making the raw scaffold spuriously valid.
- The centralised `gan stacks` help block (`src/cli/lib/help.ts`) documents `--tier=project|user` with default `project` — and that line is now **truthful**: `gan stacks new <name> --tier=user` succeeds. (The help line predates R6; R6's check is that the behaviour now matches it, not that new text was added.)
- `npx vitest run` passes; `npx tsc --noEmit` is clean.

### Manual review checks

- The activation-guidance comment block names the `stack.override` overlay field and both activation paths (same-name shadow, forced override) so a first-use author has an actionable next step at the exact location detection used to be.
- The detection-free decision is sourced to C5 and F3 in the scaffold comment and the spec prose; R3, C5, F3, and C1 are referenced as upstream shipped contracts and are **not** edited (the roadmap is the cross-reference layer, per the spec-lifecycle rule).
- Tier→body selection is centralised in `buildScaffold` (one function, one tier argument), not branched across call sites.

## Dependencies

- **R3** — the CLI wrapper and the original `gan stacks new` / scaffold contract. Shipped and immutable; R3 line 70 describes the tier-aware intent R6 implements. Readers of R3 find R6 via the roadmap.
- **C5** — three-tier stack-file resolution; the "detection is builtin-tier only" rule and the user-tier path. Shipped; not edited.
- **F3** — the `detection.tier3_only` cross-file invariant the old scaffold tripped. Shipped; not edited.
- **C1** — the stack plugin schema that also rejects project/user-tier `detection` at parse time. Shipped; not edited.
- **R1** — `atomicWriteFile`, `validateStack`, YAML frontmatter parsing the scaffold must satisfy.

Draft-spec coordination (see "Coordination with in-flight (Draft) specs"): **D1** — *requires a D1 edit*: D1's `gan stacks --help` rewrite must retain an options section documenting `--tier=project|user` (default `project`); the current D1 draft drops it. **W1** (`stack.override` shrinkage warning — R6's scaffold wording aligns with its remediation; no W1 edit), **O1** (tier-label vocabulary; no edit), **U1/U2** (overlay-authoring UX depth; no edit).

## Bite-size note

Sprintable as:

1. (small) **Make `buildScaffold` tier-aware.** Add a `tier` argument; for `project`/`user` emit the detection-free body with the activation-guidance comment in place of the `detection:` block. Test asserts no `detection` key and a clean post-edit `gan validate`.
2. (small) **Accept `--tier=user`.** Add `user` to the allowed-tier set; resolve the user-tier path; update the rejection message to name both values. Test the path, the atomic write, and the byte-for-byte equality.
3. (small) **Regression guard.** Test that the un-edited scaffold still fails `gan validate` on the banner + TODO stubs (intentional friction preserved) while a fully-edited scaffold passes (trap removed).

Slices 1–2 are independent; slice 3 is the closing guard.

## Out of scope

- **A friendlier prose stack-authoring guide.** E1 line 22 already flags this as a known follow-up; the canonical reference stays C1's schema plus existing stack files. R6 only removes the structural trap, it does not write a tutorial.
- **A builtin/repo scaffold target.** Built-in stacks ship in the npm package and are customised via `gan stacks customize`; R6 keeps that stance.
- **Auto-inferring `detection` / `scope` / commands from the host repo.** The no-detection-inference rule stands; the scaffold still emits TODO stubs the user fills in.
- **Changing the DRAFT-banner or TODO-stub friction.** Intentional and untouched; R6's contract is "no *hidden* residual invariant," not "scaffold is valid as-emitted."
- **A `--force` overwrite flag.** Scaffold-no-overwrite is R3-locked.
- **Writing the `gan stacks --help` text.** Owned by D1 (Draft); the `--tier=project|user` line already exists in shipped `help.ts`. R6 changes only the *behaviour* behind that line and records the requirement that D1's rewrite must not drop it. R6 does not author help prose.
- **`stack.override` / `discardInherited` authoring guidance.** Owned by U1/U2 (Draft). R6's scaffold comment gives the minimum pointer, not the full authoring tutorial.
