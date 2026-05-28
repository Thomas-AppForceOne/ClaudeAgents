# M4 — Docker module wiring

## Problem

The Docker module ([M2](M2-docker-module.md)) ships `PortRegistry` / `PortDiscovery` / `ContainerHealth` / `PortValidator` / `ContainerNaming` helpers (`src/modules/docker/manifest.json`), and R7 exposes them to the orchestrator as the `dockerReservePort` / `dockerDiscoverPort` / `dockerContainerName` / `dockerCheckContainerHealth` tools. But no agent prompt calls them: `agents/gan-generator.md` does not reference the module, so a generator working on a docker-active stack hand-rolls port selection and container naming in Bash — the exact per-project reinvention M2 exists to prevent. Post-R7 the helpers are *callable*; they are still *uncalled*.

M2's API was authored as **explicitly provisional** — its shape to be confirmed against a real agent call-graph. This is that confirmation: the existing Docker dogfood project is the call-graph, and wiring the generator to the real tools is what validates (or reveals a gap in) M2's surface.

## Proposed change

Rewrite `agents/gan-generator.md` so that, **when the docker module is active for the run** (`snapshot.modules.docker` present — module-keyed, not tied to any single stack in a polyglot active set), the generator obtains ports and container names from R7's docker tools instead of inventing them:

- a container name → `dockerContainerName` (deterministic on the canonical worktree path);
- a port the container binds → registered via `dockerReservePort`. **Port semantics (confirm against R7):** the shipped `PortRegistry.register(worktreePath, port, containerName)` takes a **caller-supplied** port and throws `PortInUse` if another worktree already holds it (`src/modules/docker/PortRegistry.ts:92,103`) — it is *collision-detecting*, not a free-port *allocator*. **R7 has pinned `dockerReservePort` as a thin wrapper over `register` — the caller (generator) supplies the candidate port** (no allocator; a true free-port allocator would be new domain logic in a future M2-extension spec, per R7). So the generator selects a candidate port and registers it via `dockerReservePort`, **retrying another candidate on `PortInUse`**; "collision-free across concurrent runs" comes from that registry check (backed by the F8 module-state store), not from an allocator;
- a peer container's already-bound port → `dockerDiscoverPort`.

**Port *release* is not the generator's job.** The generator reserves; it does **not** call `dockerReleasePort` at sprint/attempt exit. M2's registry is deliberately persistent across runs so a live worktree keeps its allocation (`M2-docker-module.md` recovery semantics), so release is **orchestrator/cleanup-scoped** (O2's `--cleanup` removes the run and its registry entry). Wiring a per-generator-exit release would strip a port a later attempt in the same worktree still needs.

The rewrite is **conditional**: a run with no docker module active is unaffected (the generator never calls the tools). It is a **prompt change only** (to `agents/gan-generator.md`) — M4 itself adds no schema or tool surface (the docker tools it calls ship under R7).

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — it consumes R7's already-exposed docker tools and M2's shipped helpers; it adds nothing new underneath.
2. **Composable by other agents/specs?** Yes — it is the generator-side half of docker wiring; the evaluator-side container-health *gate* is deferred to a future docker-stack-surface spec (see Scope boundary), and a later gate composes on the same `dockerContainerName`.
3. **Owns/accesses durable structured state?** Only transitively — the port registry persists through the F8 module-state store, owned by M2; M4 just calls it.
4. **Fits existing ownership lanes?** Yes — same agent-prompt lane E1 established; same module/tool surfaces R7 and M2 own. No new zone.
5. **Stackable / non-terminal?** Yes — once the generator calls the real helpers, every docker-stack run reuses one battle-tested implementation rather than re-deriving it.

### Scope boundary

- **Generator-side only. The evaluator-side container-health *gate* is NOT a v1.0 deliverable — and explicitly is not "activated by M4".** M4 owns the `gan-generator.md` rewrite. A *gating* container-health criterion is **not achievable prompt-only** and is therefore deferred: a gated criterion must (a) be authored by the **contract-proposer**, which sources criteria **only** from a stack's `securitySurfaces`/`documentationSurfaces` and is forbidden to hardcode them (`agents/gan-contract-proposer.md:77,80`), and (b) be runnable by the **evaluator-core plan**, whose `EvaluatorPlan` (`src/agents/evaluator-core/types.ts:202`) has no container-health field and is immutable E3. v1.0 ships **no `stacks/docker.md`** surface (`stacks/` holds only `generic.md`, `web-node.md`; the only `docker.md` is a test fixture — `M2-docker-module.md:177`). So a docker-active container-health criterion has **no criterion source** in v1.0. Making it gate requires either a docker stack surface (a stack-file + C1-instantiation change) or a new `EvaluatorPlan` field (an additive evaluator-core change) — **both non-prompt, both a future spec**, not M4. (An earlier draft of this spec claimed M4 "activates" the criterion prompt-only; that has no mechanism and is retracted.)
- **What E8 actually ships for docker:** the general forced-execution machinery (run the *stack's* `test`/`lint`/`build`/`audit`/`doc-lint` commands). The evaluator **may** additionally call R7's `dockerCheckContainerHealth` and surface the boot result as **advisory measurement/evidence** (a tool call, prompt-only — `gan-evaluator.md` is free to call MCP tools), but per the framework's "measurement is separate from gating; deterministic results gate only through criteria" rule, that surfaces information without auto-failing a sprint. The *gating* version waits for the future docker-stack-surface spec above.
- **M2 is shipped and not edited.** M4 cross-references [M2](M2-docker-module.md)'s helpers (`PortRegistry`, `PortDiscovery`, `ContainerHealth`, `PortValidator`, `ContainerNaming` — `src/modules/docker/manifest.json`). If the real call-graph reveals an M2 API gap, that is a *new* spec under the next free slot, not an in-place edit to M2 (per the specification-lifecycle rule).

## Acceptance criteria

- `agents/gan-generator.md` instructs a docker-active generator to obtain ports/names from R7's `dockerReservePort` / `dockerDiscoverPort` / `dockerContainerName` (it does **not** release — release is orchestrator/cleanup-scoped, see Proposed change) — verified by prompt inspection; the prompt passes `lint-no-stack-leak` and the F4 error-text discipline.
- A generator run with the docker module **inactive** makes no docker-tool call (the rewrite is strictly conditional on `snapshot.modules.docker`).
- The rewritten `gan-generator.md` keeps D2's three byte-identical house-rules regions (`hr:snapshot`, `hr:no-config-api`, `hr:errors-tail`) intact and carries zero internal spec-references — so it passes D2's `lint-no-spec-ref` and house-rules parity check (D2 lands before M4).
- The wiring is exercised against the existing Docker dogfood project: a real run reserves its port through the registry (collision-detected via `PortInUse`) rather than hard-coding one. This is **dogfood/manual** — like R7's end-to-end checks, CI has no LLM to drive the markdown generator. *(No evaluator-side container-health AC: that gate is deferred — see Scope boundary.)*

## Version bump: none

M4 is a **prompt-only** change to `agents/gan-generator.md` (generator-side only — the deferred evaluator-side gate is not part of M4); agent content is copied on every `install.sh` run, so no `package.json` bump is needed (per the pre-1.0 install-version bump discipline, roadmap § "Pre-release chores and release gate"). M4 adds no MCP tool, schema, or `gan`/server change — those it *uses* (R7's docker tools) ship and bump under R7.

## Dependencies

- **R7** — exposes the docker tools the rewrite calls (`dockerReservePort`/`dockerDiscoverPort`/`dockerContainerName`). Must land first. R7 has pinned `dockerReservePort` as a thin `register` wrapper (caller supplies the port); the generator's candidate-selection + `PortInUse`-retry is M4's prompt logic — see Proposed change.
- **D2** — lands before M4 and lints every `agents/*.md` edit (`lint-no-spec-ref` + the house-rules named-region parity check); the `gan-generator.md` rewrite must conform (three regions intact, no spec-refs).
- **E8** — ships the evaluator's general forced-execution machinery. M4 does **not** depend on E8 for the generator-side rewrite; the docker container-health *gate* E8 §3 discusses is deferred to a future docker-stack-surface spec, not activated by M4.
- **M2** — the shipped Docker module whose helpers back the tools; cross-referenced, not edited.

## Bite-size note

One conditional `gan-generator.md` prompt rewrite (generator-side only), ~1 sprint. Lands after R7 (its docker tools must exist) and after D2 (its lints gate the prompt edit). The evaluator-side container-health gate is **not** in M4 — it is deferred to a future docker-stack-surface spec.
