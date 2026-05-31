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
import independentReviewV1Json from '../../schemas/independent-review-v1.json' with { type: 'json' };

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
/** Schema for the evidence bundle the evaluator emits per run. */
export const evaluatorEvidenceBundleV1: JsonSchema = evaluatorEvidenceBundleV1Json as JsonSchema;

/**
 * Schema for the artefact the independent-reviewer agent writes per sprint
 * attempt — a list of findings plus a per-severity tally. The orchestrator's
 * reproduction guard validates a reviewer's output against this schema before
 * any finding is considered for promotion into the proposer's criteria.
 */
export const independentReviewV1: JsonSchema = independentReviewV1Json as JsonSchema;
