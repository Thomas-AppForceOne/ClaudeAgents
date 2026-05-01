/**
 * Library entry point for `@claudeagents/config-server`.
 *
 * Public, dual-callable surface (per the dual-callable surface rule in
 * PROJECT_CONTEXT.md): every function below is also reachable via the MCP
 * tool wrapper in `config-server/index.ts`. Library consumers (E1, R3,
 * R4) import them directly without spawning the server subprocess.
 *
 * Exports are grouped by category:
 *   - reads (13 functions, plus `getApiVersion` from the bootstrap entry)
 *   - writes (12 functions, including R1's loud-stub trust + module no-ops)
 *   - validate (3 functions)
 *   - shared types (`Issue`, `ResolvedConfig`, `OverlayTier`, etc.)
 *
 * The two reads `getStackConventions` and `getOverlayField` are still
 * `NotImplemented` until their owning sprints land; they are intentionally
 * not exported here.
 */

// ---- read tools ----------------------------------------------------------

export { getApiVersion } from './config-server/index.js';

export {
  getActiveStacks,
  getMergedSplicePoints,
  getModuleState,
  getOverlay,
  getResolvedConfig,
  getStack,
  getStackResolution,
  getTrustDiff,
  getTrustState,
  listModules,
} from './config-server/tools/reads.js';

// ---- write tools ---------------------------------------------------------

export {
  appendToModuleState,
  appendToOverlayField,
  appendToStackField,
  registerModule,
  removeFromModuleState,
  removeFromOverlayField,
  removeFromStackField,
  setModuleState,
  setOverlayField,
  trustApprove,
  trustRevoke,
  updateStackField,
} from './config-server/tools/writes.js';

// ---- validate tools ------------------------------------------------------

export { validateAll, validateOverlay, validateStack } from './config-server/tools/validate.js';

// ---- shared types --------------------------------------------------------

export type { Issue } from './config-server/validation/schema-check.js';
export type {
  ResolvedConfig,
  ResolvedStackEntry,
  AdditionalContextRow,
} from './config-server/resolution/resolved-config.js';
export type { OverlayTier } from './config-server/storage/overlay-loader.js';
export type { StackTier, StackResolution } from './config-server/resolution/stack-resolution.js';
export type { WriteResult } from './config-server/tools/writes.js';
