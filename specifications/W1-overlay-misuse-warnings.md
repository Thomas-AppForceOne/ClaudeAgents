# W1 — Overlay-misuse warnings

## Problem

A project-tier overlay can silently accept a `stack.override` declaration that does not have the effect the user expected. It bit a real dogfooding session and is a first-touch trap for users authoring project overlays.

**`stack.override` silent shrinkage.** When a project-tier overlay declares `stack.override`, C2's contract is "**replaces** detection wholesale." A user authoring an overlay with `stack.override: [my-custom]` to **add** their custom stack instead **suppresses** every stack auto-detection would have activated. The dogfooding case: a user wrote a `php-grav` stack with prose explicitly describing coexistence with `web-node`, and `stack.override: [php-grav]` silently dropped `web-node`. Their prose became a lie; the framework activated only `php-grav` with no warning. The C2 contract is correct (override means override); the failure mode is the silence, not the semantic.

The shape: **the overlay accepted user input but did not act on it as the user expected.** Silent acceptance with hidden non-effect is the worst category of UX bug — the framework had the data to warn the user, and didn't.

W1 introduces a unified, reusable non-aborting-warning mechanism and uses it for this surface:

- The warning surfaces in three places (orchestrator startup log, `gan stacks list` output, `gan config print` output).
- It follows a non-aborting validation discipline (the warning fires during `validateAll()` but does NOT abort the run — the user's overlay IS their stated intent and must be honored, but the divergence between intent and effect must be visible).
- It follows a single wording template ("we accepted X but it did Y because Z").

W1 is the first spec under the **W** (non-aborting warnings on user misuse) phase code. The phase is for surfaces where the framework accepts user input that may not have the user's intended effect. Future W-series specs cover analogous surfaces as they emerge.

### Deferred: per-stack command-override warning

An earlier draft of W1 carried a second warning, `PerStackOverrideUnsupported`, for a project overlay declaring per-stack command overrides (`<stack>.auditCmd` / `buildCmd` / `testCmd` / `lintCmd`). It was cut before shipping because its premise was false against the codebase: those command fields live in the **stack** schema, not the overlay schema, and `schemas/overlay-v1.json` is `additionalProperties: false`. A `<stack>: { buildCmd: … }` overlay block is therefore an *unknown property* — `validateAll()` raises an aborting `SchemaMismatch` error, not a silent no-op. The "accepted but not yet applied" scenario the warning described does not occur: there is no input for which the warning fires without a contradicting schema error, and on a real `/gan` run the aborting validation halts before any warning is surfaced. That case is an overlay **validation error** (F2's model), which W1 explicitly does not cover. Making per-stack command overrides a real, schema-valid, honoured surface is tracked in the roadmap's v1.1 entry; only once they parse cleanly and are wired through could a "recorded but not yet applied" warning be honest.

## Proposed change

### Where warnings surface

W1 introduces a unified non-aborting-warning surface in three places, all driven by the same source: a `warnings` array attached to the resolved-config snapshot.

**1. Orchestrator startup log** (per O1 part A) — when the snapshot is captured, the orchestrator emits one stderr line per warning. The warning's structured data is rendered as prose. Format:

```
warning: <code>: <message>
```

The line is non-suppressible (similar to O1's "first-run nudge" line) — warnings about the user's overlay are always visible at startup. Verbosity flags do not silence them.

**2. `gan stacks list` output** — when the warning relates to active-stack composition (specifically `StackOverrideShrinkage`), the human-format output includes an annotated breakdown showing what's active vs. what was suppressed. Example:

```
$ gan stacks list
ACTIVE for this directory:
  php-grav

SUPPRESSED by stack.override:
  web-node (would have been activated by detection)

For full coverage, list every stack you want active in stack.override.
See `gan stacks --help` for the active-vs-available distinction.
```

The annotation appears only when there is something to annotate (warnings present); the previous behavior (one stack name per line, `(none)` on empty) is preserved when no warnings apply, for scripting compatibility. The JSON output (`--json`) carries the warnings under a top-level `warnings` array regardless of human format.

**3. `gan config print` output** — the resolved-config JSON emits a top-level `warnings` array. Each entry is a structured object:

```json
{
  "warnings": [
    {
      "code": "StackOverrideShrinkage",
      "message": "Your overlay's `stack.override` set [`php-grav`] is smaller than the auto-detection result [`php-grav`, `web-node`]. Stacks suppressed: [`web-node`]. To keep them, list them in `stack.override`.",
      "details": {
        "overrideSet": ["php-grav"],
        "detectionSet": ["php-grav", "web-node"],
        "suppressed": ["web-node"]
      }
    }
  ]
}
```

In the human format, warnings are printed below the resolved-config table with the same structured prose used in the startup log.

### Warning lifecycle

Warnings are computed during `validateAll()` and attached to the snapshot. They are not aborting (per the F2 distinction between errors and warnings); the run proceeds. The warning surfaces above all read from the snapshot — they don't recompute the warning logic.

This means agents spawned during a sprint also see the warnings (via the snapshot they receive). The proposer and evaluator can incorporate warning awareness if it's relevant to their behavior — though for v1.0 they treat warnings as informational only.

A warning's structured object has:

- `code` — PascalCase identifier (per the field-encodings convention used by F2/F4 errors). Used by structured consumers and by the lint suite to assert "warning X fires for input Y."
- `message` — prose for human display. Obeys the F4 prose-discipline rule.
- `details` — code-specific payload. Discriminated by `code`.

### `StackOverrideShrinkage`

The C2 spec defines the detection algorithm; a `stack.override` declaration short-circuits it. W1 extends the resolver: when `stack.override` is non-empty, the resolver computes BOTH the override-driven active set AND the auto-detection-would-have-produced set. If the override set is strictly smaller (i.e. detection would have included stacks the override does not), the resolver attaches a `StackOverrideShrinkage` warning to the snapshot.

Detection is normally short-circuited when override is present (saves filesystem reads). For the warning, the resolver runs detection anyway. The cost is a small filesystem traversal per `validateAll()`; the user-protection is real.

**Wording for the warning:**

> Your overlay's `stack.override` set [`php-grav`] is smaller than the auto-detection result [`php-grav`, `web-node`]. Stacks suppressed by your override: [`web-node`]. If you want to KEEP the suppressed stacks alongside `php-grav`, list them in `stack.override`: `[php-grav, web-node]`. `stack.override` is a replacement, not an addition.

The wording is verbose by design — the user encountered an unintuitive behavior, and the warning is the framework's chance to teach the rule.

**When the warning does NOT fire:**

- `stack.override` is empty / absent / discardInherited-without-replacement (per C2's "empty after cascade = run auto-detection" rule).
- The override set is equal to or larger than the detection set (the user explicitly listed every detected stack plus possibly more — that's deliberate behavior, no suppression).
- The override set differs from detection but is the same size (e.g. user replaced `web-node` with `php-grav`; both are 1 stack). This is "swap" behavior, not "shrinkage" — the user replaced a detected stack with their own choice. No warning, because the user didn't lose coverage they had expected.

Edge case: detection produces an empty set (no real stack matches; `generic` is the fallback) AND override is `[php-grav]`. The override set is 1, detection-with-fallback is 1 (`generic`). No shrinkage in count terms. But the user lost `generic`'s fallback semantics. The warning fires when the override does not include `generic` AND detection would have fallen back to `generic`:

> Your overlay's `stack.override` excludes `generic`, the framework's fallback stack for projects without a recognized ecosystem. Without `generic`, no fallback semantics apply for files outside `[php-grav]`'s scope. If you want fallback semantics, include `generic` in `stack.override`: `[php-grav, generic]`.

### Warning suppression policy

Warnings cannot be suppressed via overlay declaration in v1.0. A user who wants to silence the warning either (a) corrects the overlay (lists every detected stack in `stack.override`), or (b) accepts the noise.

Future versions may introduce a `warnings.suppress` overlay surface (per-warning-code allowlist) if dogfooding shows the noise is excessive. v1.0 does not ship this — silence-by-default-for-warnings is a stronger UX position when the warnings catch real bugs.

### What W1 does not do

- Cover every overlay-misuse surface. The one covered here is the one that bit a real dogfooding session and is expressible against the current schema. Future W-series specs cover others as they emerge.
- Address overlay validation errors (those are F2's structured-error model, not W1's warnings). W1 specifically covers cases where the overlay parses correctly and is accepted by the framework, but produces an effect different from the user's apparent intent.
- Ship per-warning suppression / silencing. Deferred until usage signal warrants.
- Block sprint execution. Warnings are informational; the user's overlay IS their stated intent and runs as written.
- Cover stack-file authoring warnings (e.g. "this detection composite is overly broad"). W1 is overlay-tier; stack-tier warnings get their own treatment if needed.

## Field encodings

W1 introduces:

- **`warnings: Warning[]`** array on the resolved-config snapshot returned by `getResolvedConfig()`. Empty array when no warnings apply. Stable position in the JSON output (top-level key alongside `mergedSplicePoints`, `discarded`, `additionalContext`, `stacks`, etc.).
- **`Warning` type:**
  - `code` — PascalCase ASCII (e.g. `StackOverrideShrinkage`).
  - `message` — prose, F4-compliant.
  - `details` — code-specific payload, discriminated by `code`.
- Warning codes live in a structured-warning catalog — a code-level sibling to the existing structured-error catalog, modelled on the same shape; F2's shipped spec file is not edited. The one W1-defined code is the initial entry, and the catalog is built so a second code can be added without restructuring.
- Stderr emission format from the orchestrator: one line per warning, prefix `warning:`, then `<code>: <message>`.

## Examples

A startup-log emission with one warning:

```
$ /gan "small change"
/gan loaded:
  stacks: php-grav (project)
  user overlay: ~/.claude/gan/config.md (loaded)
  project overlay: .claude/gan/project.md (loaded)
  additionalContext: (none)
  discarded: (none)
warning: StackOverrideShrinkage: Your overlay's `stack.override` set [`php-grav`] is smaller than the auto-detection result [`php-grav`, `web-node`]. Stacks suppressed by your override: [`web-node`]. If you want to KEEP the suppressed stacks alongside `php-grav`, list them in `stack.override`: `[php-grav, web-node]`. `stack.override` is a replacement, not an addition.
```

A `gan stacks list` showing active vs. suppressed:

```
$ gan stacks list
ACTIVE for this directory:
  php-grav

SUPPRESSED by stack.override:
  web-node (would have been activated by detection)

For full coverage, list every stack you want active in stack.override.
See `gan stacks --help` for the active-vs-available distinction.
```

A `gan config print --json` excerpt with warnings:

```json
{
  "warnings": [
    {
      "code": "StackOverrideShrinkage",
      "message": "Your overlay's `stack.override` set [`php-grav`] is smaller than the auto-detection result [`php-grav`, `web-node`]. ...",
      "details": {
        "overrideSet": ["php-grav"],
        "detectionSet": ["php-grav", "web-node"],
        "suppressed": ["web-node"]
      }
    }
  ],
  "stacks": { ... },
  "overlay": { ... }
}
```

## Acceptance criteria

### Automated checks

- An overlay declaring `stack.override: [php-grav]` against a fixture that detects `[php-grav, web-node]` produces a `StackOverrideShrinkage` warning naming `web-node` as suppressed.
- An overlay declaring `stack.override: [php-grav, web-node]` (matching detection) produces no shrinkage warning.
- An overlay declaring `stack.override: [php-grav]` against a fixture that detects only `[php-grav]` (no other stack matches) produces no shrinkage warning.
- An overlay declaring `stack.override: [php-grav]` against a fixture where detection would have fallen back to `generic` produces a shrinkage warning naming `generic` as suppressed.
- The orchestrator startup log emits one `warning:` line per warning attached to the snapshot.
- `gan stacks list` (human format) annotates active vs. suppressed when warnings include `StackOverrideShrinkage`.
- `gan stacks list` (human format) shows the original "one name per line" output when no shrinkage warnings apply (no behavioral change for the script-friendly path).
- `gan stacks list --json` and `gan config print --json` emit the warnings array under a top-level `warnings` key.
- Warnings do not abort `validateAll()` — runs proceed normally with warnings present.
- The `validateAll()` non-aborting mode (`--print-config`, `--recover`, `--list-recoverable`) emits warnings alongside any structured errors.

### Manual review checks

- Warning prose obeys the F4 prose-discipline rule.
- Warning prose names the user's exact declaration in the overlay (so they can find and edit it).
- Warning prose names the remediation (what to add / remove to fix).
- The roadmap's v1.0 known-gap line and v1.1 entry for per-stack overlay command override reflect reality: today it is a `SchemaMismatch` error (the command fields are not in the overlay schema), not a silent no-op surfaced by a W1 warning; v1.1 must make the fields schema-valid and wire them through before any "recorded but not yet applied" warning would be honest.
- Per the "Implemented specs are immutable" rule, W1 does not edit C2, F2, C3, O1, or R3. W1 owns the structured-warning catalog extension, its warning code, and the surfacing rules; readers find the warning behaviour via W1 and the roadmap cross-references, not via in-place edits to the shipped specs.

## Dependencies

- **F2** — structured-error model. W1 builds on F2's model by introducing a structured-warning catalog under F2's existing contract; F2 itself is shipped and is not edited. The warning catalog lives in W1.
- **C2** — stack detection and dispatch. W1's `StackOverrideShrinkage` is the warning surface for C2's "override is replacement, not addition" semantic; C2 itself is shipped and is not edited.
- **C3** — overlay schema. W1's `StackOverrideShrinkage` reasons about C3's `stack.override` field; C3's `additionalProperties: false` is also what makes a per-stack command-override block a `SchemaMismatch` error rather than a silent no-op (see the deferred note under "Problem"). C3 itself is shipped and is not edited.
- **O1** — observability. The warning emission in startup log and `gan config print` rides O1's existing surfaces.
- **R3** — CLI wrapper. `gan stacks list` and `gan config print` outputs are R3's contract; W1 extends their content with the new warning rendering. R3 itself is shipped and is not edited; the extension is via W1's authoring of what those outputs should contain when warnings are present.
- **E1** — orchestrator; the startup log warning lines are emitted by the orchestrator after `getResolvedConfig()` returns.

## Bite-size note

Sprintable as:

1. (one sprint) Structured-warning model: a code-level warning catalog carrying the `Warning` type, integrate the `warnings` array into `getResolvedConfig()` output, ensure `validateAll()` non-aborting modes carry warnings.
2. (one sprint) `StackOverrideShrinkage` detection: resolver computes detection-set even when override is non-empty, compares, emits warning. Includes the `generic`-fallback edge case.
3. (one sprint) Orchestrator startup log emission: one line per warning, F4-compliant prose, non-suppressible.
4. (one sprint) `gan stacks list` annotation: active-vs-suppressed table when shrinkage warnings present, JSON `warnings` array always.
5. (one sprint) `gan config print` integration: top-level `warnings` array in human and JSON outputs.
6. (one sprint) Test coverage: warning fixtures, edge cases (empty override, override-equals-detection, override-larger-than-detection, same-size swap, generic fallback).

Slices 1–2 must land in order; slices 3–5 depend on 1–2 and can land in parallel. Slice 6 depends on all of 1–5.
