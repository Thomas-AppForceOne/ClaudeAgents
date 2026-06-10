/**
 * Compile-time bundling of the project's JSON Schemas.
 *
 * The schema files live under `schemas/` as plain `.json`. Importing them via
 * the `with { type: 'json' }` import attribute inlines their contents into the
 * build, so the running server never has to read them from disk at runtime —
 * this is what lets schema validation work even when the package is installed
 * read-only or the schema files are not co-located with the bundle. The
 * `as JsonSchema` casts simply narrow the inferred JSON literal type to the
 * shared structural type the validation layer consumes.
 */

import stackV1Json from '../../schemas/stack-v1.json' with { type: 'json' };
import overlayV1Json from '../../schemas/overlay-v1.json' with { type: 'json' };
import apiToolsV1Json from '../../schemas/api-tools-v1.json' with { type: 'json' };
import moduleManifestV1Json from '../../schemas/module-manifest-v1.json' with { type: 'json' };
import runTraceV1Json from '../../schemas/run-trace-v1.json' with { type: 'json' };
import runTraceIndexV1Json from '../../schemas/run-trace-index-v1.json' with { type: 'json' };
import evaluatorEvidenceBundleV1Json from '../../schemas/evaluator-evidence-bundle-v1.json' with { type: 'json' };
import evaluatorEvidenceBundleV2Json from '../../schemas/evaluator-evidence-bundle-v2.json' with { type: 'json' };
import independentReviewV1Json from '../../schemas/independent-review-v1.json' with { type: 'json' };
import progressV1Json from '../../schemas/progress-v1.json' with { type: 'json' };
import telemetryConfigV1Json from '../../schemas/telemetry-config-v1.json' with { type: 'json' };
import telemetryOutcomeV1Json from '../../schemas/telemetry-outcome-v1.json' with { type: 'json' };

/** Structural type of a bundled JSON Schema document (an opaque JSON object). */
export type JsonSchema = Record<string, unknown>;

/** Schema for a stack `.md` file's YAML body (`schemaVersion: 1`). */
export const stackV1: JsonSchema = stackV1Json as JsonSchema;
/** Schema for an overlay `.md` file's YAML body (`schemaVersion: 1`). */
export const overlayV1: JsonSchema = overlayV1Json as JsonSchema;
/** Schema describing the config-server's MCP tool surface (names + inputs). */
export const apiToolsV1: JsonSchema = apiToolsV1Json as JsonSchema;
/** Schema for a module manifest declaring a module's identity and state keys. */
export const moduleManifestV1: JsonSchema = moduleManifestV1Json as JsonSchema;

/** Schema for a single `/gan` run-trace record. */
export const runTraceV1: JsonSchema = runTraceV1Json as JsonSchema;
/** Schema for the index that aggregates per-run trace records. */
export const runTraceIndexV1: JsonSchema = runTraceIndexV1Json as JsonSchema;
/** Schema for the evidence bundle the evaluator emits per run (legacy v1; retained read-only). */
export const evaluatorEvidenceBundleV1: JsonSchema = evaluatorEvidenceBundleV1Json as JsonSchema;

/**
 * Schema for the evidence bundle the evaluator emits per run, v2.
 *
 * v2 adds a required `evaluatorPromptDigest` field carrying the lowercase
 * SHA-256 hex digest of `agents/gan-evaluator.md`, stamped by the orchestrator
 * at evaluator spawn and forwarded by the evaluator into the emitted bundle.
 * The new field is required at the root and pinned by `pattern:
 * "^[0-9a-f]{64}$"`. Because the v1 schema declares `additionalProperties:
 * false`, a new required field cannot ride additively on v1; v2 is therefore
 * the breaking-change destination and the new write path for every evidence
 * bundle emitted from this spec forward. v1 stays exported for legacy reads
 * (an O2 `--recover` flow on an older run dir).
 */
export const evaluatorEvidenceBundleV2: JsonSchema = evaluatorEvidenceBundleV2Json as JsonSchema;

/**
 * Schema for the artefact the independent-reviewer agent writes per sprint
 * attempt — a list of findings plus a per-severity tally. The orchestrator's
 * reproduction guard validates a reviewer's output against this schema before
 * any finding is considered for promotion into the proposer's criteria.
 */
export const independentReviewV1: JsonSchema = independentReviewV1Json as JsonSchema;

/**
 * Strict schema for the orchestrator-owned `progress.json` file under each run
 * directory — the reconciliation merge gate's load-bearing surface. Consumers
 * (recovery, future cleanup, schema-publishing) should reach the bundled object
 * via this export rather than re-parsing the JSON file from disk, so any drift
 * between the on-disk source and the bundled copy is caught by the
 * schemas-bundled parity tests. The `with { type: 'json' }` import attribute
 * inlines the file at build time, matching the rest of the bundled set.
 */
export const progressV1: JsonSchema = progressV1Json as JsonSchema;

/**
 * Strict schema for the `telemetry/config.json` artefact O3 writes once at run
 * start. The schema pins the envelope (schemaVersion / capturedAt / runId) and
 * the ten getResolvedConfig() top-level fields F2 owns, so a partial snapshot
 * fails validation — the drift O3 exists to prevent. The bundled constant is
 * what the writer and any reader (recovery, future T2 stats surface) compile
 * against without touching disk; the on-disk file remains the canonical
 * source, and the schemas-bundled parity test catches drift between the two.
 */
export const telemetryConfigV1: JsonSchema = telemetryConfigV1Json as JsonSchema;

/**
 * Strict schema for the `telemetry/outcome.json` artefact O3 writes once at
 * run termination. The schema pins the disposition / terminalReason
 * vocabularies, the per-sprint outcome shape, the nullable cost rollup with
 * its complete:boolean discriminator (so a lossy trace cannot silently
 * undercount), the safety-halt summary, and the reserved-empty humanReviews
 * slot E6 v1.2 will land items into without forcing a v2 bump. Bundled the
 * same way the rest of the project's schemas are bundled — the `with { type:
 * 'json' }` import attribute inlines the file at build time so runtime
 * validation works against the installed package.
 */
export const telemetryOutcomeV1: JsonSchema = telemetryOutcomeV1Json as JsonSchema;
