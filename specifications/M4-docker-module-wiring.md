# M4 — Docker module wiring

## Problem

The Docker module (M2) ships `PortRegistry` / `PortDiscovery` / `ContainerHealth` / `ContainerNaming` helpers, and R7 exposes them to the orchestrator as the `dockerReservePort` / `dockerDiscoverPort` / `dockerContainerName` / `dockerCheckContainerHealth` tools. But no agent prompt calls them: `agents/gan-generator.md` does not reference the module, so a generator working on a docker-active stack hand-rolls port selection and container naming in Bash — the exact per-project reinvention M2 exists to prevent. Post-R7 the helpers are *callable*; they are still *uncalled*.

M2's API was authored as **explicitly provisional** — its shape to be confirmed against a real agent call-graph. This is that confirmation: the existing Docker dogfood project is the call-graph, and wiring the generator to the real tools is what validates (or reveals a gap in) M2's surface.

## Proposed change

Rewrite `agents/gan-generator.md` so that, **when a docker module is active for the run's stack**, the generator obtains ports and container names from R7's docker tools instead of inventing them:

- a port the container binds → `dockerReservePort` (registry-backed, collision-free across concurrent runs via the F8 module-state store), released with `dockerReleasePort`;
- a peer container's port → `dockerDiscoverPort`;
- a container name → `dockerContainerName`.

The rewrite is **conditional**: a stack with no docker module is unaffected (the generator never calls the tools). It is a **prompt change only** — no new Config API surface and no schema change.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — it consumes R7's already-exposed docker tools and M2's shipped helpers; it adds nothing new underneath.
2. **Composable by other agents/specs?** Yes — it is the generator-side half of docker wiring; E8 owns the evaluator-side `ContainerHealth` gate, and the two compose on the same module.
3. **Owns/accesses durable structured state?** Only transitively — the port registry persists through the F8 module-state store, owned by M2; M4 just calls it.
4. **Fits existing ownership lanes?** Yes — same agent-prompt lane E1 established; same module/tool surfaces R7 and M2 own. No new zone.
5. **Stackable / non-terminal?** Yes — once the generator calls the real helpers, every docker-stack run reuses one battle-tested implementation rather than re-deriving it.

### Scope boundary

- **Generator-side only.** M4 owns the `gan-generator.md` rewrite. The **evaluator-side** gate — running `dockerCheckContainerHealth` and gating a criterion on whether the built container actually boots — is owned by **[E8](E8-independent-review-and-forced-verification.md) §3 "Forced deterministic verification"**, not duplicated here. M4 and E8 are the two halves of slot-18 docker wiring.
- **M2 is shipped and not edited.** M4 cross-references M2's helpers. If the real call-graph reveals an M2 API gap, that is a *new* spec under the next free slot, not an in-place edit to M2 (per the specification-lifecycle rule).

## Acceptance criteria

- `agents/gan-generator.md` instructs a docker-active generator to obtain ports/names from R7's `dockerReservePort` / `dockerDiscoverPort` / `dockerContainerName` and to release with `dockerReleasePort` — verified by prompt inspection; the prompt passes `lint-no-stack-leak` and the F4 error-text discipline.
- A generator run on a **non-docker** stack makes no docker-tool call (the rewrite is strictly conditional).
- The wiring is exercised against the existing Docker dogfood project: a real run reserves its port through the registry rather than hard-coding one. This is **dogfood/manual** — like R7's end-to-end checks, CI has no LLM to drive the markdown generator.

## Dependencies

- **R7** — exposes the docker tools the rewrite calls. Must land first.
- **E8** — owns the paired evaluator-side `ContainerHealth` gate (slot 18's other half).
- **M2** — the shipped Docker module whose helpers back the tools; cross-referenced, not edited.

## Bite-size note

One conditional prompt rewrite, ~1–2 sprints. Lands after R7 (its tools must exist) and pairs with E8's evaluator-side gate.
