---
name: synthetic-second
schemaVersion: 1
scope:
  - "synthetic/**"
buildCmd: "echo synthetic-second build"
testCmd: "echo synthetic-second test"
lintCmd: "echo synthetic-second lint"
documentationSurfaces:
  - id: synthetic_doc_keyword_surface
    template: >
      Synthetic-second exports must document the SYNTHETIC_FOO contract: each
      parameter's meaning, the failure modes, and any invariant the caller must
      uphold.
    triggers:
      keywords:
        - "SYNTHETIC_FOO"
        - "synthetic-export"
      scope:
        - "synthetic/**"
  - id: synthetic_doc_scope_only_surface
    template: >
      Comments added to files inside the synthetic scope must explain a
      constraint or a non-obvious decision and its rationale, not restate the
      adjacent code.
    triggers:
      scope:
        - "synthetic/**/*.txt"
docLintCmd:
  command: "echo synthetic-second doc-lint"
  fallback: "echo synthetic-second doc-lint-fallback"
  absenceSignal: warning
  absenceMessage: "No documentation linter is configured for the synthetic-second stack."
  severity: blocker
  baseline: delta
---

# synthetic-second conventions

Project-tier override fixture. Has no `detection` block (per the
`detection-tier3-only` invariant — detection lives only in the built-in
tier). The full multi-stack synthetic stack file with composite detection
lands in S5/S7 when the synthetic-second built-in fixture grows.

It carries Q5's `documentationSurfaces` (both a keyword + scope trigger
and a scope-only trigger) and a `docLintCmd`, kept consistent with the
polyglot copy's Q5 fields so the multi-stack guard rail exercises the new
fields in both seeds.
