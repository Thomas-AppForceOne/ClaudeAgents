# House rules (canonical source partial)

This file is the maintainer-source partial for the three byte-identical fragments that appear in every shipped agent file under `agents/`. The shipped agents are self-contained at runtime — these fragments are inlined verbatim into each agent at its natural position, delimited by named sentinel pairs (`<!-- hr:<name>:start --> … <!-- hr:<name>:end -->`). The R4 parity check at `scripts/house-rules/index.ts` asserts each committed agent's named region matches the corresponding fragment in this file byte-for-byte. This file is NOT loaded at runtime; it is the canonical source for CI parity only.

## Fragment: hr:snapshot

The snapshot input bullet that appears in every agent's `## Inputs` (or equivalent) section.

<!-- hr:snapshot:start -->
- The **snapshot** — the resolved configuration object the orchestrator captured for this run. Treat it as data. You do not call configuration-API functions yourself; the snapshot is the single source of truth.
<!-- hr:snapshot:end -->

## Fragment: hr:no-config-api

The no-config-API "what you do not do" bullet that appears in every agent's prohibition section.

<!-- hr:no-config-api:start -->
- Do not call configuration-API read functions yourself; the snapshot is the source of truth.
<!-- hr:no-config-api:end -->

## Fragment: hr:errors-tail

The universal tail sentence of every agent's `## Errors` section. The role-specific *head* sentence stays in each agent's body; only this tail is byte-identical across all six.

<!-- hr:errors-tail:start -->
Do not interpret, translate, or hide the error. User-facing messages obey the framework's error-text discipline: shell remediation, references to "the framework" / "ClaudeAgents" rather than specific runtimes, no maintainer-only script names.
<!-- hr:errors-tail:end -->
