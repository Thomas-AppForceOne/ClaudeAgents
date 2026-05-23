---
name: synthetic-second
description: synthetic-second fixture (polyglot multi-stack guard rail)
schemaVersion: 1
detection:
  - anyOf:
      - .synthetic-marker
      - synthetic/**
  - allOf:
      - .synthetic-marker
      - anyOf:
          - synthetic/foo.txt
          - synthetic/bar.txt
scope:
  - "synthetic/**"
secretsGlob:
  - txt
  - md
cacheEnv:
  - envVar: SYNTHETIC_CACHE_HOME
    valueTemplate: "<worktree>/.gan-cache/synthetic"
auditCmd:
  command: "echo synthetic-second audit"
  fallback: "echo synthetic-second audit-fallback"
  absenceSignal: warning
  absenceMessage: "No audit tool configured for the synthetic-second stack."
buildCmd: "echo synthetic-second build"
testCmd: "echo synthetic-second test"
lintCmd: "echo synthetic-second lint"
securitySurfaces:
  - id: synthetic_keyword_surface
    template: >
      Synthetic-second files must guard against unsanitised inputs flowing
      through the SYNTHETIC_FOO callsite.
    triggers:
      keywords:
        - "SYNTHETIC_FOO"
        - "synthetic-input"
      scope:
        - "synthetic/**"
  - id: synthetic_scope_only_surface
    template: >
      Files inside the synthetic scope must declare their handler signature
      explicitly.
    triggers:
      scope:
        - "synthetic/**/*.txt"
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

Synthetic, fixture-only stack used as the multi-stack guard rail (per the
roadmap's cross-cutting principle). Exercises every C1 schema field:
composite detection (both `allOf` and `anyOf`), `scope`, `secretsGlob`,
`cacheEnv`, `auditCmd` with `absenceSignal: warning`, the three command
fields, and `securitySurfaces` with both keyword + scope triggers and a
scope-only trigger. It also exercises Q5's two fields:
`documentationSurfaces` with both a keyword + scope trigger and a
scope-only trigger, and a `docLintCmd` with `severity: blocker`,
`baseline: delta`, and `absenceSignal: warning`.
