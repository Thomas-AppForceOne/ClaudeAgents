---
name: generic
description: Conservative fallback stack for projects with no recognised ecosystem. Activates when no other stack matches.
schemaVersion: 1
scope:
  - '**/*'
secretsGlob:
  - env
securitySurfaces:
  - id: secrets_not_committed
    template: >
      Credentials, API keys, tokens, and private keys must not appear
      in any file committed to the repository. Secrets are loaded at
      runtime from environment variables or an external secrets store.
    triggers:
      keywords:
        - 'password'
        - 'secret'
        - 'api_key'
        - 'apiKey'
        - 'private_key'
        - 'token'
  - id: untrusted_input_handling
    template: >
      Every externally-sourced value (user input, file content, command
      arguments, environment variables, network responses) must be
      validated and rejected if malformed before it reaches business
      logic or persistent storage.
    triggers:
      keywords:
        - 'input'
        - 'argv'
        - 'stdin'
        - 'readFile'
        - 'request'
  - id: error_message_hygiene
    template: >
      Errors returned to external callers must not contain stack
      traces, internal file paths, or system configuration details.
      Internal failures are logged with the full context; the response
      to the caller is a sanitised message.
    triggers:
      keywords:
        - 'stack trace'
        - 'Error('
        - 'throw'
        - 'panic'
  - id: secure_defaults
    template: >
      The application must start in a secure configuration without
      manual hardening — no debug endpoints exposed, no default
      credentials, and no world-readable sensitive files. Hardening
      that depends on operator action is not a default.
    triggers:
      keywords:
        - 'debug'
        - 'DEBUG'
        - '0.0.0.0'
documentationSurfaces:
  - id: public_contract_completeness
    template: >
      Every public function, type, or interface added or changed in this
      sprint documents, in its doc comment, each parameter's meaning (not
      merely its type), the failure modes it can raise, any side effect beyond
      its return value, and any invariant the caller must uphold.
  - id: comments_explain_why_not_what
    template: >
      Every comment added in this sprint explains a constraint, an invariant,
      or a non-obvious decision and its rationale — not a restatement of what
      the adjacent code already expresses. No added comment can be deleted
      without losing information absent from the code itself.
  - id: nonobvious_decision_cites_rationale
    template: >
      Any non-obvious implementation decision in changed code (a workaround, a
      performance trade-off, an ordering constraint) cites its rationale in a
      comment or doc contract.
---

# generic conventions

The `generic` stack is the framework's fallback. It activates when no
ecosystem-specific stack matches the project root, ensuring that every
project still receives the universal security surfaces (secret hygiene,
input validation, error-message discipline, secure defaults) and the
universal documentation surfaces (public-contract completeness, comments
that explain *why* not *what*, and a rationale citation on non-obvious
decisions). The documentation surfaces carry no `triggers`, so they are
language-neutral judgment rules that apply wherever the fallback is
active.

The stack file declares no `detection` block — by convention, the
framework activates `generic` only when the active set would otherwise
be empty. There is no `auditCmd`: a meaningful dependency audit needs
a known toolchain, and the fallback by definition has none. For the same
reason there is no `docLintCmd` — a deterministic documentation linter
needs a known toolchain the fallback does not have, so `generic` ships
the judgment surfaces and leaves the deterministic layer to a real stack.
The ecosystem-specific commands (`buildCmd`, `testCmd`, `lintCmd`) are
likewise absent; consumers operating under `generic` rely on the
overlay cascade to declare project-specific commands when needed.

`scope` is `**/*` so every file in the project participates in the
universal surfaces; `secretsGlob` covers the cross-ecosystem `.env`
convention.
