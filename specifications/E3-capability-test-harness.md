# E3 — Capability test harness

## Problem

E2 extracts the framework's hardcoded stack logic into declarative `stacks/<name>.md` files and rewrites agents to use the Configuration API. The refactor is mechanical but the surface area is large. Without a test harness, regressions in evaluator output (a security surface goes missing, a glob shifts, a command is no longer issued) only show up when a user notices.

This spec defines the harness that gates the refactor: a fixed set of fixture projects, expected JSON outputs, and a normalisation step that turns them into machine-comparable artifacts.

## Proposed change

### Layout

```
tests/fixtures/stacks/
  js-ts-minimal/
    src/...                    # the fixture project
    .gan/expected.json         # the golden file
  python-minimal/
    ...
  polyglot-android-node/
    ...
  node-packaged-non-web/
    ...
  android-minimal/
    ...
  generic-fallback/
    ...
```

Each fixture is a minimal but realistic project. The fixture's `expected.json` is the evaluator output the harness asserts against.

### Bootstrap fixture set

The first phase of fixtures, drafted alongside E2:

- **`js-ts-minimal/`** — small JS/TS project with `package.json` + lockfile + `start` script. Exercises web-node detection, `npm audit`, web-stack security surfaces.
- **`python-minimal/`** — `pyproject.toml` + one module. Exercises Python detection and `pip-audit`.
- **`polyglot-android-node/`** — both an Android Gradle project and a Node interop directory. Exercises detection union, scope filtering, no-cross-contamination.
- **`node-packaged-non-web/`** — `package.json` only, no lockfile, no scripts. Exercises C1's tightened web-node detection (must fall through to generic).
- **`android-minimal/`** — minimal Android Gradle project. Exercises S1's stack file end-to-end.
- **`generic-fallback/`** — repo with no recognised stack. Exercises C2's `stacks/generic.md` activation.

Additional fixtures land alongside each new stack (S2 KMP, S3 iOS) using the same harness.

### Golden files

Golden files are hand-authored, not auto-captured. The harness asserts what the system *should* produce, not what it happened to produce before. This is appropriate for a pre-1.0 WIP project where existing behavior may be wrong and we want the test to drive correctness.

Each golden file is a JSON document with the same shape the evaluator emits. It is committed to the repo and reviewed on change like any other artifact.

### Normalisation

Raw evaluator output contains run-specific noise (timestamps, durations, PIDs, worktree paths, token counts, model identifiers). Comparing it directly against a golden produces false negatives every run. The harness normalises before diffing:

1. **Strip volatile fields:** timestamps, durations, PIDs, worktree paths, token counts, model identifiers.
2. **Sort unordered arrays** by a documented key (e.g. `blockingConcerns` by `id`, `securityCriteria` by `name`).
3. **Canonicalise paths:** strip `<run-id>` and `<worktree-id>` segments under `.gan-state/runs/` and `.gan-cache/`, leaving the trailing relative path.
4. **Stable JSON formatting:** sort object keys, two-space indent, trailing newline.

The list of fields stripped and arrays sorted is declared in a single configuration file (`tests/fixtures/normalise-rules.json`) so the rule set is version-controlled and reviewable.

### Diff

After normalisation, the harness diffs the captured output against the golden file using a structural JSON diff (not text diff). On any difference, the diff is printed in human-readable form with file paths, field names, and a side-by-side view.

### Reference implementation

`scripts/capability-check/` (per R4). Node 18+. Loads each fixture, invokes the evaluator (in a controlled mode that captures output without spawning a real `/gan` run), normalises, diffs.

CI invokes `node scripts/capability-check` via `test-capability.yml`.

### Updating goldens

When the evaluator's intended output changes (new stack, new criterion, schema bump), the maintainer:

1. Edits the relevant golden files by hand, or
2. Runs `node scripts/capability-check --update-goldens` which captures current normalised output and writes it to the goldens.

`--update-goldens` is opt-in and never runs in CI. The maintainer reviews the diff before committing.

## Acceptance criteria

- The bootstrap fixture set listed above is committed under `tests/fixtures/stacks/` with a hand-authored `expected.json` per fixture.
- `node scripts/capability-check` exits 0 with no diff when run against an unmodified repo at the fixture's golden state.
- `node scripts/capability-check` exits non-zero with a structured human-readable diff when the evaluator's output drifts from the golden.
- Normalisation rules live in a single committed file and are referenced by the harness; modifying them requires a reviewable commit.
- `--update-goldens` writes normalised output to the goldens; running it twice in a row is a no-op.
- Adding a new fixture requires no harness change beyond placing the fixture and its `expected.json`.
- The harness output never contains run-volatile data (timestamps, paths with run-ids, etc.) so a CI failure log is reproducible from the same commit.

## Dependencies

- C1, C2 (data the fixtures exercise)

E2 is gated by this harness, not the other way around. R4 hosts the reference script's filename in its directory layout but the format described here is authored independently of R4.

## Bite-size note

Sprintable as: harness skeleton + one fixture (`js-ts-minimal`) + normalisation rules → second fixture for cross-contamination → remaining bootstrap fixtures → `--update-goldens` flag → CI integration.
