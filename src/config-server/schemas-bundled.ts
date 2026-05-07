/**
 * Bundled JSON Schema documents. Importing the schemas via Node's ESM JSON
 * import attributes lets us ship them as compile-time data without a
 * runtime fs read, while still keeping the canonical files under
 * `<repo>/schemas/` (per F3).
 */

import stackV1Json from '../../schemas/stack-v1.json' with { type: 'json' };
import overlayV1Json from '../../schemas/overlay-v1.json' with { type: 'json' };
import apiToolsV1Json from '../../schemas/api-tools-v1.json' with { type: 'json' };
import moduleManifestV1Json from '../../schemas/module-manifest-v1.json' with { type: 'json' };

export type JsonSchema = Record<string, unknown>;

export const stackV1: JsonSchema = stackV1Json as JsonSchema;
export const overlayV1: JsonSchema = overlayV1Json as JsonSchema;
export const apiToolsV1: JsonSchema = apiToolsV1Json as JsonSchema;
export const moduleManifestV1: JsonSchema = moduleManifestV1Json as JsonSchema;
