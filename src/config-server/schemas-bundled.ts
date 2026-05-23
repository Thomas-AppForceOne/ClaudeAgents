

import stackV1Json from '../../schemas/stack-v1.json' with { type: 'json' };
import overlayV1Json from '../../schemas/overlay-v1.json' with { type: 'json' };
import apiToolsV1Json from '../../schemas/api-tools-v1.json' with { type: 'json' };
import moduleManifestV1Json from '../../schemas/module-manifest-v1.json' with { type: 'json' };
import runTraceV1Json from '../../schemas/run-trace-v1.json' with { type: 'json' };
import runTraceIndexV1Json from '../../schemas/run-trace-index-v1.json' with { type: 'json' };
import evaluatorEvidenceBundleV1Json from '../../schemas/evaluator-evidence-bundle-v1.json' with { type: 'json' };

export type JsonSchema = Record<string, unknown>;

export const stackV1: JsonSchema = stackV1Json as JsonSchema;
export const overlayV1: JsonSchema = overlayV1Json as JsonSchema;
export const apiToolsV1: JsonSchema = apiToolsV1Json as JsonSchema;
export const moduleManifestV1: JsonSchema = moduleManifestV1Json as JsonSchema;

export const runTraceV1: JsonSchema = runTraceV1Json as JsonSchema;
export const runTraceIndexV1: JsonSchema = runTraceIndexV1Json as JsonSchema;
export const evaluatorEvidenceBundleV1: JsonSchema = evaluatorEvidenceBundleV1Json as JsonSchema;
