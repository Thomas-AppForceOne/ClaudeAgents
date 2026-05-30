#!/usr/bin/env node
/**
 * Entry point and MCP wiring for the config-server.
 *
 * This module is the boundary between the Model Context Protocol transport and
 * the read/write/validate tool implementations. It owns:
 * - the canonical list of tool names ({@link F2_TOOL_NAMES}/{@link R5_TOOL_NAMES});
 * - a dispatch table ({@link TOOL_HANDLERS}) mapping each tool name to its
 *   required args and a handler that validates input then calls the impl;
 * - the MCP `Server` that exposes those tools, plus a small CLI
 *   (`--version`, `--validate-all`, or stdio MCP mode).
 *
 * Boundary guarantees stated once here:
 * - Every fault that reaches the MCP layer becomes a JSON error response
 *   ({@link errorResponse}) rather than crashing the server; only a
 *   {@link ConfigServerError} keeps its code, everything else is reported as
 *   `NotImplemented` with the original message.
 * - Tool arguments are anonymised before logging ({@link anonymiseToolArgs})
 *   so config values, state, manifests, and trust hashes never reach a log.
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createError, ConfigServerError } from './errors.js';
import { getLogger } from './logging/logger.js';
import { packageRoot as resolvePackageRoot } from './package-root.js';
import { apiToolsV1 } from './schemas-bundled.js';
import {
  REPO_KEY_PATTERN,
  RUN_ID_PATTERN,
  resolveStoreRoot,
} from './storage/run-store.js';
import {
  getActiveStacks as readGetActiveStacks,
  getBoundedDirectoryListing as readGetBoundedDirectoryListing,
  getMergedSplicePoints as readGetMergedSplicePoints,
  getModuleState as readGetModuleState,
  getOverlay as readGetOverlay,
  getResolvedConfig as readGetResolvedConfig,
  getStack as readGetStack,
  getStackResolution as readGetStackResolution,
  getTrustDiff as readGetTrustDiff,
  getTrustState as readGetTrustState,
  listModules as readListModules,
  requireName,
  requireOverlayTier,
  requireProjectRoot,
  trustList as readTrustList,
} from './tools/reads.js';
import {
  validateAll as runValidateAll,
  validateOverlay as runValidateOverlay,
  validateStack as runValidateStack,
} from './tools/validate.js';
import {
  appendToModuleState as runAppendToModuleState,
  appendToOverlayField as runAppendToOverlayField,
  appendToStackField as runAppendToStackField,
  registerModule as runRegisterModule,
  removeFromModuleState as runRemoveFromModuleState,
  removeFromOverlayField as runRemoveFromOverlayField,
  removeFromStackField as runRemoveFromStackField,
  setModuleState as runSetModuleState,
  setOverlayField as runSetOverlayField,
  trustApprove as runTrustApprove,
  trustRevoke as runTrustRevoke,
  updateStackField as runUpdateStackField,
} from './tools/writes.js';
import {
  createRunWorkspaceTool as runCreateRunWorkspace,
  resolveRunStoreTool as runResolveRunStore,
} from './tools/run-context.js';
import {
  acquireRunLockTool as runAcquireRunLock,
  releaseRunLockTool as runReleaseRunLock,
} from './tools/run-lock.js';
import {
  aggregateRunSummaryTool as runAggregateRunSummary,
  buildLoopDetectedBodyTool as runBuildLoopDetectedBody,
  buildTrustEventBodyTool as runBuildTrustEventBody,
  buildValidationAbortBodyTool as runBuildValidationAbortBody,
  buildValidationAbortFromCodeTool as runBuildValidationAbortFromCode,
  emitTraceEventTool as runEmitTraceEvent,
  formatHeartbeatTool as runFormatHeartbeat,
  formatLlmCallSummaryTool as runFormatLlmCallSummary,
  reconcileTraceIndexTool as runReconcileTraceIndex,
  reconstructRecoveryStateTool as runReconstructRecoveryState,
  runSprintSummaryTool as runRunSprintSummary,
} from './tools/trace.js';
import {
  checkRoleCeilingTool as runCheckRoleCeiling,
  checkSprintBudgetTool as runCheckSprintBudget,
  createEditOscillationErrorTool as runCreateEditOscillationError,
  createLoopDetectedErrorTool as runCreateLoopDetectedError,
  createSprintBudgetErrorTool as runCreateSprintBudgetError,
  detectEditOscillationTool as runDetectEditOscillation,
} from './tools/safety.js';
import { buildEvaluatorPlanTool as runBuildEvaluatorPlan } from './tools/evaluator-tools.js';
// Docker tool handlers are intentionally imported from the local tools file
// (which uses dynamic `import()` per-handler) rather than from
// `../modules/docker/*` directly. A top-level static import of any path under
// `src/modules/docker/*` would execute that module's import-time
// `docker --version` prerequisite check, crashing every config tool on every
// host without a docker binary. The static-scan guard in the docker tool
// tests pins this property as a regression.
import {
  dockerCheckContainerHealth as runDockerCheckContainerHealth,
  dockerContainerName as runDockerContainerName,
  dockerDiscoverPort as runDockerDiscoverPort,
  dockerReleasePort as runDockerReleasePort,
  dockerReservePort as runDockerReservePort,
} from './tools/docker-tools.js';

/**
 * The advertised tool surface: the core read, write, and validate tools
 * introduced by feature set F2, plus additive read tools landed by later
 * features. This is the advertised tool list (filtered to those with a
 * registered handler in {@link buildToolList}). Order is the catalogue order
 * shown to clients.
 */
export const F2_TOOL_NAMES: readonly string[] = [
  'getApiVersion',
  'getResolvedConfig',
  'getStack',
  'getStackConventions',
  'getActiveStacks',
  'getOverlay',
  'getOverlayField',
  'getMergedSplicePoints',
  'getStackResolution',
  'getBoundedDirectoryListing',
  'getTrustState',
  'getTrustDiff',
  'getModuleState',
  'listModules',

  'setOverlayField',
  'appendToOverlayField',
  'removeFromOverlayField',
  'updateStackField',
  'appendToStackField',
  'removeFromStackField',
  'trustApprove',
  'trustRevoke',
  'setModuleState',
  'appendToModuleState',
  'removeFromModuleState',
  'registerModule',

  'validateAll',
  'validateStack',
  'validateOverlay',
] as const;

/**
 * Tool names introduced by feature set R5 (read-side trust listing), kept
 * separate from {@link F2_TOOL_NAMES} so the two feature sets remain
 * distinguishable, but unioned for dispatch.
 */
export const R5_TOOL_NAMES: readonly string[] = ['trustList'] as const;

/**
 * Tool names introduced by the runtime invocation bridge — the run-context
 * resolver/creator pair and the release-by-key run-lock pair. Kept separate
 * from {@link F2_TOOL_NAMES} so the additive surface stays auditable; unioned
 * into {@link DISPATCH_TOOL_NAMES} for the actual dispatch.
 */
export const RUN_CONTEXT_TOOL_NAMES: readonly string[] = [
  'resolveRunStore',
  'createRunWorkspace',
  'acquireRunLock',
  'releaseRunLock',
] as const;

/**
 * Tool names introduced by the runtime invocation bridge's trace surface —
 * the eleven thin handlers behind the shared trace library functions. Kept
 * in its own list so the additive surface stays auditable; unioned into
 * {@link DISPATCH_TOOL_NAMES} for actual dispatch.
 */
export const TRACE_TOOL_NAMES: readonly string[] = [
  'emitTraceEvent',
  'runSprintSummary',
  'formatHeartbeat',
  'formatLlmCallSummary',
  'aggregateRunSummary',
  'reconcileTraceIndex',
  'reconstructRecoveryState',
  'buildTrustEventBody',
  'buildValidationAbortBody',
  'buildValidationAbortFromCode',
  'buildLoopDetectedBody',
] as const;

/**
 * Tool names introduced by the runtime invocation bridge's safety surface —
 * the six thin handlers behind the shared safety library functions. Kept in
 * its own list so the additive surface stays auditable; unioned into
 * {@link DISPATCH_TOOL_NAMES} for actual dispatch. The three halt-decision
 * tools (`checkRoleCeiling`, `checkSprintBudget`, `detectEditOscillation`)
 * and the three matching error-builder tools (`createLoopDetectedError`,
 * `createSprintBudgetError`, `createEditOscillationError`) live together
 * because they share the `LoopDetected` halt contract.
 */
export const SAFETY_TOOL_NAMES: readonly string[] = [
  'checkRoleCeiling',
  'checkSprintBudget',
  'detectEditOscillation',
  'createLoopDetectedError',
  'createSprintBudgetError',
  'createEditOscillationError',
] as const;

/**
 * Tool names introduced by the runtime invocation bridge's evaluator-core
 * surface — a single thin handler behind the shipped deterministic
 * `buildEvaluatorPlan` library function. Kept in its own list so the
 * additive surface stays auditable; unioned into
 * {@link DISPATCH_TOOL_NAMES} for actual dispatch.
 */
export const EVALUATOR_TOOL_NAMES: readonly string[] = ['buildEvaluatorPlan'] as const;

/**
 * Tool names introduced by the runtime invocation bridge's docker-module
 * surface — five thin, lazy-loaded wrappers over the shipped docker module
 * library functions (`PortRegistry.register` / `.release`, `discoverPort`,
 * `waitForHealthy`, `nameForWorktree`). Kept in its own list so the additive
 * surface stays auditable; unioned into {@link DISPATCH_TOOL_NAMES}. Each
 * handler dynamically imports its library function inside the handler body
 * so the server boots cleanly on a host without a `docker` binary.
 */
export const DOCKER_TOOL_NAMES: readonly string[] = [
  'dockerReservePort',
  'dockerReleasePort',
  'dockerDiscoverPort',
  'dockerCheckContainerHealth',
  'dockerContainerName',
] as const;

/**
 * Every tool name the dispatcher will accept (F2 ∪ R5 ∪ run-context ∪ trace
 * ∪ safety ∪ evaluator ∪ docker). A `tools/call` for a name outside this set
 * is rejected as an unknown tool. Note this is a superset of the *advertised*
 * list — advertising additionally requires a registered handler (see
 * {@link buildToolList}).
 */
export const DISPATCH_TOOL_NAMES: readonly string[] = [
  ...F2_TOOL_NAMES,
  ...R5_TOOL_NAMES,
  ...RUN_CONTEXT_TOOL_NAMES,
  ...TRACE_TOOL_NAMES,
  ...SAFETY_TOOL_NAMES,
  ...EVALUATOR_TOOL_NAMES,
  ...DOCKER_TOOL_NAMES,
];

// The slice of package.json this server cares about (name + version).
interface PackageMeta {
  name: string;
  version: string;
}

// Process-lifetime memo: package.json does not change while the server runs,
// so it is read and parsed at most once.
let cachedMeta: PackageMeta | null = null;

/**
 * Read the package `name` and `version` from the resolved package root.
 *
 * @returns the memoised {@link PackageMeta}; the first call reads and parses
 *   `package.json`, later calls return the cache.
 * @throws if `package.json` cannot be read or is not valid JSON (a broken
 *   install — there is no sensible fallback).
 */
export async function readPackageMeta(): Promise<PackageMeta> {
  if (cachedMeta) return cachedMeta;
  const pkgPath = path.join(resolvePackageRoot(), 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as PackageMeta;
  cachedMeta = { name: parsed.name, version: parsed.version };
  return cachedMeta;
}

/**
 * The `getApiVersion` tool: report the server's API version (its package
 * version).
 *
 * @returns `{ apiVersion }` — the package version string.
 */
export async function getApiVersion(): Promise<{ apiVersion: string }> {
  const meta = await readPackageMeta();
  return { apiVersion: meta.version };
}

/**
 * One advertised tool's metadata.
 *
 * @property name the tool name.
 * @property description human-facing description shown to MCP clients.
 * @property required the input keys the tool requires (from its handler spec).
 * @property inputSchema the JSON Schema for the tool's input, sourced from the
 *   bundled api-tools schema (or a permissive empty-object schema as fallback).
 */
export interface ToolListEntry {
  name: string;
  description: string;

  required: readonly string[];

  inputSchema: Record<string, unknown>;
}

/**
 * Build the advertised tool catalogue.
 *
 * Iterates {@link F2_TOOL_NAMES} in order but includes only names that have a
 * registered handler in {@link TOOL_HANDLERS} — so a name listed but not yet
 * wired is silently omitted from advertisement rather than advertised and then
 * failing on call. Each entry's `inputSchema` comes from the bundled
 * api-tools-v1 schema; a missing/ill-shaped schema entry falls back to a
 * permissive empty-object schema.
 *
 * @returns the list of advertisable {@link ToolListEntry}s.
 */
export function buildToolList(): ToolListEntry[] {
  const props = (apiToolsV1.properties ?? {}) as Record<
    string,
    { inputSchema?: unknown; description?: unknown }
  >;
  // Advertise every dispatcher-known name (F2 + R5 + run-context) that has a
  // registered handler. Earlier this filtered F2 names only, leaving R5 and
  // later additive tools dispatchable-but-unadvertised; we expand to the full
  // dispatch set so a markdown orchestrator can discover the run-context pair.
  return DISPATCH_TOOL_NAMES.filter((name) =>
    Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name),
  ).map((name) => {
    const schemaEntry = props[name];
    const inputSchema =
      schemaEntry && typeof schemaEntry === 'object' && schemaEntry.inputSchema
        ? (schemaEntry.inputSchema as Record<string, unknown>)
        : { type: 'object', additionalProperties: false, properties: {} };
    // Prefer a per-tool catalog `description` when the schema entry supplies
    // one — that is where a tool documents behaviour an LLM caller must know
    // (e.g. that a "Check" tool actually BLOCKS while polling). Fall back to
    // the generic auto-string for entries that carry no bespoke description.
    const description =
      schemaEntry && typeof schemaEntry === 'object' && typeof schemaEntry.description === 'string'
        ? schemaEntry.description
        : `ClaudeAgents config-server tool: ${name}`;
    return {
      name,
      description,
      required: TOOL_HANDLERS[name].required,
      inputSchema,
    };
  });
}

/**
 * Construct and wire the MCP `Server`.
 *
 * Registers two request handlers: `ListTools` (returns the
 * {@link buildToolList} catalogue) and `CallTool` (validates the name against
 * {@link DISPATCH_TOOL_NAMES}, logs an anonymised start record, dispatches via
 * {@link dispatchRead}, and maps success/failure to MCP responses).
 *
 * @returns the configured (but not yet connected) server.
 *
 * Error handling: an unknown tool, a thrown {@link ConfigServerError}, or any
 * other thrown value all become a JSON error response — the handler never lets
 * an exception escape to the transport. A tool that the dispatcher reports as
 * unhandled is surfaced as `NotImplemented`.
 */
export async function createMcpServer(): Promise<Server> {
  const meta = await readPackageMeta();
  const server = new Server(
    {
      name: meta.name,
      version: meta.version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const logger = getLogger();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = buildToolList().map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    // Reject unknown tools up front so the dispatch table is only ever invoked
    // for a recognised name.
    if (!DISPATCH_TOOL_NAMES.includes(toolName)) {
      const err = createError('MalformedInput', {
        tool: toolName,
        message: `Unknown tool '${toolName}'.`,
      });
      logger.warn('tools/call: unknown tool', { tool: toolName, code: err.code });
      return errorResponse(err);
    }

    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      // Log only the anonymised argument shape — never raw values/state/hashes.
      logger.info('tools/call: start', {
        tool: toolName,
        anonymisedArgs: anonymiseToolArgs(args),
      });
      const result = await dispatchRead(toolName, args, logger);
      if (result !== UNHANDLED) {
        logger.info('tools/call: ok', { tool: toolName, code: 'OK' });
        return successResponse(result);
      }
      // Recognised name but no handler ran: treat as not-yet-implemented.
      throw createError('NotImplemented', { tool: toolName });
    } catch (e) {
      // Map any throw to an error response: a ConfigServerError passes through
      // with its code intact; anything else is wrapped as NotImplemented so the
      // original message is preserved without leaking a stack to the client.
      const err =
        e instanceof ConfigServerError
          ? e
          : createError('NotImplemented', {
              tool: toolName,
              message: e instanceof Error ? e.message : String(e),
            });
      logger.warn('tools/call: error', { tool: toolName, code: err.code });
      return errorResponse(err);
    }
  });

  return server;
}

// Wrap a tool's return value as a successful MCP text-content response (the
// value is JSON-encoded into a single text block).
function successResponse(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

// Wrap an error as an MCP error response. The error is serialised via
// `toJSON()` so the client receives the stable code + context, not the live
// Error (name/stack are dropped).
function errorResponse(err: ConfigServerError): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }],
    isError: true,
  };
}

// Sentinel returned by dispatchRead when no handler exists for a (recognised)
// tool name. A unique Symbol so it can never collide with a real tool result,
// including `undefined`/`null`.
const UNHANDLED = Symbol('unhandled');
type Unhandled = typeof UNHANDLED;

// Per-call context threaded into every handler. Currently just the logger, so
// trust-related tools can emit through the same sink.
interface HandlerContext {
  logger: ReturnType<typeof getLogger>;
}

// A tool handler: validates/extracts its args and invokes the implementation.
// May be sync or async; the dispatcher awaits the result either way.
type ToolHandler = (
  args: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<unknown> | unknown;

// One dispatch-table entry: the required input keys (advertised in the tool
// list) plus the handler to run.
interface ToolHandlerSpec {
  readonly required: readonly string[];
  readonly handler: ToolHandler;
}

/**
 * The dispatch table: tool name → its required args and handler. Each handler
 * pulls its inputs from the raw `args` via the `require*`/`optional*` helpers
 * (which throw `MalformedInput` on bad input) before calling the corresponding
 * read/write/validate implementation. This table is the single source of truth
 * for what each tool needs and does.
 */
const TOOL_HANDLERS: Readonly<Record<string, ToolHandlerSpec>> = {
  getApiVersion: {
    required: [],
    handler: () => getApiVersion(),
  },
  getResolvedConfig: {
    required: ['projectRoot'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getResolvedConfig');
      return readGetResolvedConfig({ projectRoot });
    },
  },
  getStack: {
    required: ['projectRoot', 'name'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getStack');
      const name = requireName(args, 'getStack');
      return readGetStack({ projectRoot, name });
    },
  },
  getActiveStacks: {
    required: ['projectRoot'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getActiveStacks');
      return readGetActiveStacks({ projectRoot });
    },
  },
  getOverlay: {
    required: ['projectRoot', 'tier'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getOverlay');
      const tier = requireOverlayTier(args, 'getOverlay');
      return readGetOverlay({ projectRoot, tier });
    },
  },
  getMergedSplicePoints: {
    required: ['projectRoot'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getMergedSplicePoints');
      return readGetMergedSplicePoints({ projectRoot });
    },
  },
  getStackResolution: {
    required: ['projectRoot', 'name'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getStackResolution');
      const name = requireName(args, 'getStackResolution');
      return readGetStackResolution({ projectRoot, name });
    },
  },
  getBoundedDirectoryListing: {
    required: ['projectRoot'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getBoundedDirectoryListing');
      return readGetBoundedDirectoryListing({ projectRoot });
    },
  },
  getTrustState: {
    required: ['projectRoot'],
    handler: (args, ctx) => {
      const projectRoot = requireProjectRoot(args, 'getTrustState');
      return readGetTrustState({ projectRoot }, { logger: ctx.logger });
    },
  },
  getTrustDiff: {
    required: ['projectRoot'],
    handler: (args, ctx) => {
      const projectRoot = requireProjectRoot(args, 'getTrustDiff');
      return readGetTrustDiff({ projectRoot }, { logger: ctx.logger });
    },
  },
  trustList: {
    required: [],
    handler: (_args, ctx) => readTrustList({}, { logger: ctx.logger }),
  },
  getModuleState: {
    required: ['projectRoot', 'name', 'key'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'getModuleState');
      const name = requireName(args, 'getModuleState');
      const key = requireStateKey(args, 'getModuleState');
      return readGetModuleState({ projectRoot, name, key });
    },
  },
  listModules: {
    required: ['projectRoot'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'listModules');
      return readListModules({ projectRoot });
    },
  },
  validateAll: {
    required: ['projectRoot'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'validateAll');
      return runValidateAll({ projectRoot });
    },
  },
  validateStack: {
    required: ['projectRoot', 'name'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'validateStack');
      const name = requireName(args, 'validateStack');
      return runValidateStack({ projectRoot, name });
    },
  },
  validateOverlay: {
    required: ['projectRoot', 'tier'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'validateOverlay');
      const tier = requireOverlayTier(args, 'validateOverlay');
      return runValidateOverlay({ projectRoot, tier });
    },
  },
  setOverlayField: {
    required: ['projectRoot', 'tier', 'fieldPath', 'value'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'setOverlayField');
      const tier = requireOverlayTier(args, 'setOverlayField');
      const fieldPath = requireFieldPath(args, 'setOverlayField');
      const value = requirePresentValue(args, 'setOverlayField', 'value');
      return runSetOverlayField({ projectRoot, tier, fieldPath, value });
    },
  },
  appendToOverlayField: {
    required: ['projectRoot', 'tier', 'fieldPath', 'value'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'appendToOverlayField');
      const tier = requireOverlayTier(args, 'appendToOverlayField');
      const fieldPath = requireFieldPath(args, 'appendToOverlayField');
      const value = requirePresentValue(args, 'appendToOverlayField', 'value');
      return runAppendToOverlayField({ projectRoot, tier, fieldPath, value });
    },
  },
  removeFromOverlayField: {
    required: ['projectRoot', 'tier', 'fieldPath', 'value'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'removeFromOverlayField');
      const tier = requireOverlayTier(args, 'removeFromOverlayField');
      const fieldPath = requireFieldPath(args, 'removeFromOverlayField');
      const value = requirePresentValue(args, 'removeFromOverlayField', 'value');
      return runRemoveFromOverlayField({ projectRoot, tier, fieldPath, value });
    },
  },
  updateStackField: {
    required: ['projectRoot', 'name', 'fieldPath', 'value'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'updateStackField');
      const name = requireName(args, 'updateStackField');
      const fieldPath = requireFieldPath(args, 'updateStackField');
      const value = requirePresentValue(args, 'updateStackField', 'value');
      return runUpdateStackField({ projectRoot, name, fieldPath, value });
    },
  },
  appendToStackField: {
    required: ['projectRoot', 'name', 'fieldPath', 'value'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'appendToStackField');
      const name = requireName(args, 'appendToStackField');
      const fieldPath = requireFieldPath(args, 'appendToStackField');
      const value = requirePresentValue(args, 'appendToStackField', 'value');
      return runAppendToStackField({ projectRoot, name, fieldPath, value });
    },
  },
  removeFromStackField: {
    required: ['projectRoot', 'name', 'fieldPath', 'value'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'removeFromStackField');
      const name = requireName(args, 'removeFromStackField');
      const fieldPath = requireFieldPath(args, 'removeFromStackField');
      const value = requirePresentValue(args, 'removeFromStackField', 'value');
      return runRemoveFromStackField({ projectRoot, name, fieldPath, value });
    },
  },
  trustApprove: {
    required: ['projectRoot'],
    handler: (args, ctx) => {
      const projectRoot = requireProjectRoot(args, 'trustApprove');
      const contentHash = optionalContentHash(args);
      const note = optionalNote(args);
      return runTrustApprove({ projectRoot, contentHash, note }, { logger: ctx.logger });
    },
  },
  trustRevoke: {
    required: ['projectRoot'],
    handler: (args, ctx) => {
      const projectRoot = requireProjectRoot(args, 'trustRevoke');
      return runTrustRevoke({ projectRoot }, { logger: ctx.logger });
    },
  },
  setModuleState: {
    required: ['projectRoot', 'name', 'key', 'state'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'setModuleState');
      const name = requireName(args, 'setModuleState');
      const key = requireStateKey(args, 'setModuleState');
      const state = requirePresentValue(args, 'setModuleState', 'state');
      return runSetModuleState({ projectRoot, name, key, state });
    },
  },
  appendToModuleState: {
    required: ['projectRoot', 'name', 'key', 'fieldPath', 'value'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'appendToModuleState');
      const name = requireName(args, 'appendToModuleState');
      const key = requireStateKey(args, 'appendToModuleState');
      const fieldPath = requireFieldPath(args, 'appendToModuleState');
      const value = requirePresentValue(args, 'appendToModuleState', 'value');

      const duplicatePolicy = optionalDuplicatePolicy(args) as
        | 'error'
        | 'skip'
        | 'allow'
        | undefined;
      return runAppendToModuleState({
        projectRoot,
        name,
        key,
        fieldPath,
        value,
        ...(duplicatePolicy !== undefined ? { duplicatePolicy } : {}),
      });
    },
  },
  removeFromModuleState: {
    required: ['projectRoot', 'name', 'key', 'entryKey'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'removeFromModuleState');
      const name = requireName(args, 'removeFromModuleState');
      const key = requireStateKey(args, 'removeFromModuleState');
      const entryKey = requireEntryKey(args, 'removeFromModuleState');
      return runRemoveFromModuleState({ projectRoot, name, key, entryKey });
    },
  },
  registerModule: {
    required: ['projectRoot', 'name'],
    handler: (args) => {
      const projectRoot = requireProjectRoot(args, 'registerModule');
      const name = requireName(args, 'registerModule');
      const manifest = readValue(args, 'manifest');
      return runRegisterModule({ projectRoot, name, manifest });
    },
  },
  resolveRunStore: {
    // Neither fromDir nor runId is required: a no-argument call mints a fresh
    // runId and resolves from process.cwd(), the run-start shape. Recovery and
    // cleanup pass an explicit runId; both shapes are valid.
    required: [],
    handler: (args) => {
      const input: { fromDir?: string; runId?: string } = {};
      const fromDir = args['fromDir'];
      if (typeof fromDir === 'string' && fromDir.length > 0) input.fromDir = fromDir;
      const runId = args['runId'];
      if (typeof runId === 'string' && runId.length > 0) input.runId = runId;
      return runResolveRunStore(input);
    },
  },
  createRunWorkspace: {
    required: ['subject', 'runId'],
    handler: (args) => {
      const subject = requireSubject(args, 'createRunWorkspace');
      const runId = requireRunId(args, 'createRunWorkspace');
      const input: {
        subject: string;
        runId: string;
        fromDir?: string;
        newWorktree?: boolean;
      } = { subject, runId };
      const fromDir = args['fromDir'];
      if (typeof fromDir === 'string' && fromDir.length > 0) input.fromDir = fromDir;
      if (typeof args['newWorktree'] === 'boolean') input.newWorktree = args['newWorktree'];
      return runCreateRunWorkspace(input);
    },
  },
  acquireRunLock: {
    required: ['repoKey', 'runId'],
    handler: (args, ctx) => {
      const repoKey = requireRepoKey(args, 'acquireRunLock');
      const runId = requireRunId(args, 'acquireRunLock');
      // Route stale-break notices through the structured logger so they join
      // the same stream as the other R7 tools instead of escaping onto raw
      // stderr (the library's bare default).
      return runAcquireRunLock(
        { repoKey, runId },
        { warn: (line) => ctx.logger.warn('run-lock: stale-break', { line }) },
      );
    },
  },
  releaseRunLock: {
    // `runId` is required so the path-form release can prove holder identity
    // before unlinking — a delayed, stale release from a superseded run that
    // only knows `repoKey` must not delete a live successor's lock. See
    // `releaseRunLockTool` for the mismatch-as-silent-no-op contract.
    required: ['repoKey', 'runId'],
    handler: (args) => {
      const repoKey = requireRepoKey(args, 'releaseRunLock');
      const runId = requireRunId(args, 'releaseRunLock');
      return runReleaseRunLock({ repoKey, runId });
    },
  },
  emitTraceEvent: {
    required: ['runDir', 'event'],
    handler: (args) => {
      const runDir = requireRunDir(args, 'emitTraceEvent');
      const event = requireEventPayload(args, 'emitTraceEvent');
      // The shipped library validates the event shape on reconcile (the
      // schema-check pass); the boundary asserts presence + object shape
      // and leaves field-level validation to the library, so the cast here
      // is safe by construction.
      return runEmitTraceEvent({
        runDir,
        event: event as unknown as Parameters<typeof runEmitTraceEvent>[0]['event'],
      });
    },
  },
  runSprintSummary: {
    required: ['runDir'],
    handler: (args) => {
      const runDir = requireRunDir(args, 'runSprintSummary');
      return runRunSprintSummary({ runDir });
    },
  },
  formatHeartbeat: {
    required: ['role'],
    handler: (args) => {
      const role = requireRoleArg(args, 'formatHeartbeat');
      return runFormatHeartbeat({ role });
    },
  },
  formatLlmCallSummary: {
    required: ['metrics'],
    handler: (args) => {
      const metrics = requireMetricsArg(args, 'formatLlmCallSummary');
      // The downstream formatter reads only the documented LlmCallMetrics
      // fields; extra keys on the boundary object are silently ignored.
      return runFormatLlmCallSummary({
        metrics: metrics as unknown as Parameters<typeof runFormatLlmCallSummary>[0]['metrics'],
      });
    },
  },
  aggregateRunSummary: {
    required: ['runDir'],
    handler: (args) => {
      const runDir = requireRunDir(args, 'aggregateRunSummary');
      return runAggregateRunSummary({ runDir });
    },
  },
  reconcileTraceIndex: {
    required: ['runDir'],
    handler: (args) => {
      const runDir = requireRunDir(args, 'reconcileTraceIndex');
      return runReconcileTraceIndex({ runDir });
    },
  },
  reconstructRecoveryState: {
    required: ['runDir'],
    handler: (args) => {
      const runDir = requireRunDir(args, 'reconstructRecoveryState');
      return runReconstructRecoveryState({ runDir });
    },
  },
  buildTrustEventBody: {
    required: ['resolution'],
    handler: (args) => {
      const resolution = requireTrustResolutionArg(args, 'buildTrustEventBody');
      return runBuildTrustEventBody({
        resolution: resolution as unknown as Parameters<
          typeof runBuildTrustEventBody
        >[0]['resolution'],
      });
    },
  },
  buildValidationAbortBody: {
    required: ['stage', 'error'],
    handler: (args) => {
      const stage = requireValidationStageArg(args, 'buildValidationAbortBody');
      const error = requireF2ErrorArg(args, 'buildValidationAbortBody');
      return runBuildValidationAbortBody({
        stage: stage as unknown as Parameters<typeof runBuildValidationAbortBody>[0]['stage'],
        error: error as unknown as Parameters<typeof runBuildValidationAbortBody>[0]['error'],
      });
    },
  },
  buildValidationAbortFromCode: {
    required: ['stage', 'code'],
    handler: (args) => {
      const stage = requireValidationStageArg(args, 'buildValidationAbortFromCode');
      const code = requireErrorCodeArg(args, 'buildValidationAbortFromCode');
      const details = optionalErrorDetailsArg(args);
      const typedStage = stage as unknown as Parameters<
        typeof runBuildValidationAbortFromCode
      >[0]['stage'];
      const typedCode = code as unknown as Parameters<
        typeof runBuildValidationAbortFromCode
      >[0]['code'];
      return runBuildValidationAbortFromCode(
        details !== undefined
          ? { stage: typedStage, code: typedCode, details }
          : { stage: typedStage, code: typedCode },
      );
    },
  },
  buildLoopDetectedBody: {
    required: ['halt'],
    handler: (args) => {
      const halt = requireLoopHaltArg(args, 'buildLoopDetectedBody');
      return runBuildLoopDetectedBody({
        halt: halt as unknown as Parameters<typeof runBuildLoopDetectedBody>[0]['halt'],
      });
    },
  },
  checkRoleCeiling: {
    // Flat-shape boundary, matching sibling safety tools (`checkSprintBudget`,
    // `detectEditOscillation`, `buildEvaluatorPlan`): `attemptState`, `ceilings`
    // and `evidence` are read directly off `args`. The library's
    // `CheckRoleCeilingInput` is constructed here from the flat wire shape so
    // wire and library disagree only on shape, never on contract.
    required: ['attemptState', 'ceilings', 'evidence', 'role'],
    handler: (args) => {
      const role = requireRoleArg(args, 'checkRoleCeiling');
      return runCheckRoleCeiling({
        role,
        attemptState: args['attemptState'] as Parameters<
          typeof runCheckRoleCeiling
        >[0]['attemptState'],
        ceilings: args['ceilings'] as Parameters<typeof runCheckRoleCeiling>[0]['ceilings'],
        evidence: args['evidence'] as Parameters<typeof runCheckRoleCeiling>[0]['evidence'],
      });
    },
  },
  checkSprintBudget: {
    required: ['attemptStateByRole'],
    handler: (args) => {
      const stateMap = requireAttemptStateByRoleArg(args, 'checkSprintBudget');
      const budgetRaw = args['budget'];
      const budget =
        typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
      const input: Parameters<typeof runCheckSprintBudget>[0] = {
        attemptStateByRole: stateMap as Parameters<
          typeof runCheckSprintBudget
        >[0]['attemptStateByRole'],
      };
      if (budget !== undefined) input.budget = budget;
      return runCheckSprintBudget(input);
    },
  },
  detectEditOscillation: {
    required: ['history'],
    handler: (args) => {
      const history = requireFingerprintHistoryArg(args, 'detectEditOscillation');
      const ceilingRaw = args['oscillationDetection'];
      const oscillationDetection =
        typeof ceilingRaw === 'number' && Number.isFinite(ceilingRaw) ? ceilingRaw : undefined;
      const input: Parameters<typeof runDetectEditOscillation>[0] = {
        history: history as Parameters<typeof runDetectEditOscillation>[0]['history'],
      };
      if (oscillationDetection !== undefined) input.oscillationDetection = oscillationDetection;
      return runDetectEditOscillation(input);
    },
  },
  createLoopDetectedError: {
    required: ['fields', 'traceDir'],
    handler: (args) => {
      const fields = requireLoopDetectedFieldsArg(args, 'createLoopDetectedError');
      const traceDir = requireTraceDirArg(args, 'createLoopDetectedError');
      return runCreateLoopDetectedError({
        fields: fields as unknown as Parameters<typeof runCreateLoopDetectedError>[0]['fields'],
        traceDir,
      });
    },
  },
  createSprintBudgetError: {
    required: ['fields', 'traceDir'],
    handler: (args) => {
      const fields = requireLoopDetectedFieldsArg(args, 'createSprintBudgetError');
      const traceDir = requireTraceDirArg(args, 'createSprintBudgetError');
      return runCreateSprintBudgetError({
        fields: fields as unknown as Parameters<typeof runCreateSprintBudgetError>[0]['fields'],
        traceDir,
      });
    },
  },
  createEditOscillationError: {
    required: ['fields', 'traceDir'],
    handler: (args) => {
      const fields = requireLoopDetectedFieldsArg(args, 'createEditOscillationError');
      const traceDir = requireTraceDirArg(args, 'createEditOscillationError');
      return runCreateEditOscillationError({
        fields: fields as unknown as Parameters<typeof runCreateEditOscillationError>[0]['fields'],
        traceDir,
      });
    },
  },
  buildEvaluatorPlan: {
    // The library's three positional arguments (snapshot, sprintPlan,
    // worktreeState) are carried on the MCP wire as one object with the same
    // three named fields; the boundary asserts each is a plain non-array
    // object so the library never sees a non-object where its sub-builders
    // expect structured input. Field-level shape validation is the library's
    // job — the boundary is presence + shape only.
    required: ['snapshot', 'sprintPlan', 'worktreeState'],
    handler: (args) => {
      const snapshot = requirePlanObjectArg(args, 'buildEvaluatorPlan', 'snapshot');
      const sprintPlan = requirePlanObjectArg(args, 'buildEvaluatorPlan', 'sprintPlan');
      const worktreeState = requirePlanObjectArg(args, 'buildEvaluatorPlan', 'worktreeState');
      return runBuildEvaluatorPlan({
        snapshot: snapshot as unknown as Parameters<typeof runBuildEvaluatorPlan>[0]['snapshot'],
        sprintPlan: sprintPlan as unknown as Parameters<
          typeof runBuildEvaluatorPlan
        >[0]['sprintPlan'],
        worktreeState: worktreeState as unknown as Parameters<
          typeof runBuildEvaluatorPlan
        >[0]['worktreeState'],
      });
    },
  },
  dockerReservePort: {
    // Caller-supplies-port semantics: the registry refuses cross-worktree
    // collisions via PortInUse; no free-port allocator is implied. The
    // wrapper's dynamic import inside the handler is what keeps the docker
    // module's import-time prerequisite check from running at server boot.
    required: ['worktreePath', 'port', 'containerName'],
    handler: (args) => {
      const worktreePath = requireWorktreePathArg(args, 'dockerReservePort');
      const port = requirePortArg(args, 'dockerReservePort');
      const containerName = requireContainerNameArg(args, 'dockerReservePort');
      return runDockerReservePort({ worktreePath, port, containerName });
    },
  },
  dockerReleasePort: {
    // The library's release(worktreePath) keys on the worktree alone; the
    // tool surface mirrors that contract, so `port` is not part of the
    // input or the result. `released` reflects whether the library actually
    // removed an entry vs. a no-op on an unregistered worktree.
    required: ['worktreePath'],
    handler: (args) => {
      const worktreePath = requireWorktreePathArg(args, 'dockerReleasePort');
      return runDockerReleasePort({ worktreePath });
    },
  },
  dockerDiscoverPort: {
    // Every layer input is individually optional; the library skips a layer
    // whose inputs are absent. No single field is required, but the catalog
    // schema sets minProperties:1 so a structurally-empty `{}` call is
    // rejected at the boundary rather than exhausting every layer and
    // surfacing the library's PortNotDiscovered throw at runtime.
    required: [],
    handler: (args) => {
      const input: Parameters<typeof runDockerDiscoverPort>[0] = {};
      const envVar = args['envVar'];
      if (typeof envVar === 'string' && envVar.length > 0) input.envVar = envVar;
      const worktreePath = args['worktreePath'];
      if (typeof worktreePath === 'string' && worktreePath.length > 0) {
        // Same store-redirection guard the other docker tools apply via
        // requireWorktreePathArg — the discover layer-2 registry is addressed
        // by this path too, so an unconstrained value could dodge collision
        // detection just as a reserve call could.
        assertWorktreePathShape(worktreePath, 'dockerDiscoverPort');
        input.worktreePath = worktreePath;
      }
      const containerPattern = args['containerPattern'];
      if (typeof containerPattern === 'string' && containerPattern.length > 0) {
        input.containerPattern = containerPattern;
      }
      const fallbackPort = args['fallbackPort'];
      if (typeof fallbackPort === 'number' && Number.isFinite(fallbackPort)) {
        input.fallbackPort = fallbackPort;
      }
      return runDockerDiscoverPort(input);
    },
  },
  dockerCheckContainerHealth: {
    // Wraps waitForHealthy(port, options). The contract acknowledged
    // ambiguity between {containerName} and {port,...}; this surface is
    // pinned to the library's port-based shape to keep the wrapper
    // free of new domain logic (a containerName-to-port resolution layer
    // would add behaviour beyond the library).
    required: ['port', 'path', 'expectStatus', 'timeoutSeconds'],
    handler: (args) => {
      const port = requirePortArg(args, 'dockerCheckContainerHealth');
      const pathArg = requireHttpPathArg(args, 'dockerCheckContainerHealth');
      const expectStatus = requireExpectStatusArg(args, 'dockerCheckContainerHealth');
      const timeoutSeconds = requireTimeoutSecondsArg(args, 'dockerCheckContainerHealth');
      return runDockerCheckContainerHealth({
        port,
        path: pathArg,
        expectStatus,
        timeoutSeconds,
      });
    },
  },
  dockerContainerName: {
    // Wraps nameForWorktree(worktreePath). Deterministic, pure; the library
    // canonicalises internally so the wrapper does no pre-processing.
    required: ['worktreePath'],
    handler: (args) => {
      const worktreePath = requireWorktreePathArg(args, 'dockerContainerName');
      return runDockerContainerName({ worktreePath });
    },
  },
};

// Look up and run the handler for `toolName`. Returns the {@link UNHANDLED}
// sentinel when no handler is registered (the caller then reports
// NotImplemented). Despite the `Read` name it dispatches every tool kind
// (read/write/validate).
async function dispatchRead(
  toolName: string,
  args: Record<string, unknown>,
  logger: ReturnType<typeof getLogger>,
): Promise<unknown | Unhandled> {
  const spec = TOOL_HANDLERS[toolName];
  if (spec === undefined) return UNHANDLED;
  return spec.handler(args, { logger });
}

// Extract a required non-empty `fieldPath` string, or throw MalformedInput
// (tagged with the tool name and field) so the caller sees a precise error.
function requireFieldPath(args: Record<string, unknown>, tool: string): string {
  const fp = args['fieldPath'];
  if (typeof fp !== 'string' || fp.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'fieldPath',
      message: `Tool '${tool}' requires a non-empty 'fieldPath' string in its input.`,
    });
  }
  return fp;
}

// Extract a required non-empty module-state `key`, or throw MalformedInput.
function requireStateKey(args: Record<string, unknown>, tool: string): string {
  const k = args['key'];
  if (typeof k !== 'string' || k.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'key',
      message: `Tool '${tool}' requires a non-empty 'key' string in its input.`,
    });
  }
  return k;
}

// Extract a required non-empty `entryKey`, or throw MalformedInput.
function requireEntryKey(args: Record<string, unknown>, tool: string): string {
  const k = args['entryKey'];
  if (typeof k !== 'string' || k.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'entryKey',
      message: `Tool '${tool}' requires a non-empty 'entryKey' string in its input.`,
    });
  }
  return k;
}

// Extract a required non-empty `subject` string for createRunWorkspace.
// Subject seeds the branch slug; an empty subject would yield a malformed
// branch name, so the tool boundary rejects it up front (the underlying
// library would not).
function requireSubject(args: Record<string, unknown>, tool: string): string {
  const s = args['subject'];
  if (typeof s !== 'string' || s.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'subject',
      message: `Tool '${tool}' requires a non-empty 'subject' string in its input.`,
    });
  }
  return s;
}

// Extract a required non-empty `runId` string. acquireRunLock and
// createRunWorkspace both need it; resolveRunStore treats it as optional and
// mints when absent, so this helper is reused only by the required-input
// tools.
function requireRunId(args: Record<string, unknown>, tool: string): string {
  const s = args['runId'];
  if (typeof s !== 'string' || s.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'runId',
      message: `Tool '${tool}' requires a non-empty 'runId' string in its input.`,
    });
  }
  return s;
}

/**
 * Extract a required `repoKey` string shaped exactly like a value produced
 * by `computeRepoKey` (`<basename>-<12 hex>`, matched against
 * {@link REPO_KEY_PATTERN}). Pre-R7 the repoKey was server-derived and
 * never crossed the wire, so its shape was a construction-time invariant;
 * once R7 promoted it to a tool input the invariant became a trust
 * assumption a caller can break. A free-form string would let
 * `path.join(storeRoot, repoKey, …)` resolve outside `storeRoot` via `..`
 * segments and cause `mkdirSync(..., { recursive: true })` + `linkSync`
 * to land the lock file under an attacker-chosen path. The pattern match
 * refutes that whole class up front.
 *
 * Exported so the boundary check can be exercised directly in unit tests —
 * the dispatcher table itself is module-private, but the helpers it relies
 * on are auditable as named exports.
 */
export function requireRepoKey(args: Record<string, unknown>, tool: string): string {
  const s = args['repoKey'];
  if (typeof s !== 'string' || s.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'repoKey',
      message: `Tool '${tool}' requires a non-empty 'repoKey' string in its input.`,
    });
  }
  if (!REPO_KEY_PATTERN.test(s)) {
    throw createError('MalformedInput', {
      tool,
      field: 'repoKey',
      message:
        `Tool '${tool}' requires 'repoKey' to match the producer's shape ` +
        `(\`<basename>-<12 hex>\` per computeRepoKey); reject path traversal, ` +
        `path separators, NUL, and any other characters at the wire boundary.`,
    });
  }
  return s;
}

// Read an optional argument as-is, without presence/type validation
// (defaults to the `value` key). Used for payloads the impl validates itself,
// e.g. a module manifest.
function readValue(args: Record<string, unknown>, key: string = 'value'): unknown {
  return args[key];
}

/**
 * Extract a required `runDir` string shaped exactly like the value
 * `resolveRunStore` mints — i.e. an absolute, normalised path that decomposes
 * as `<storeRoot>/<repoKey>/runs/<runId>` with `<repoKey>` and `<runId>`
 * shape-matching their canonical regexes. Pre-R7 the value was server-side
 * only; once it became a wire input every downstream syscall
 * (`mkdirSync(..., { recursive: true })`, `openSync('wx')`, `path.join(.., 'trace')`,
 * `path.basename(runDir)`) inherited a trust assumption the wire layer must
 * re-impose. A free-form `runDir` would let the trace tools create arbitrary
 * directories anywhere the server uid can write, scan unrelated directories
 * via the summary readers, and inject `..` into `reconcileTraceIndex`'s
 * `path.basename`-derived `runId`. Decomposing against `resolveStoreRoot()` +
 * the two known patterns refutes that class wholesale.
 *
 * Exported so the boundary check can be exercised directly in unit tests —
 * see {@link requireRepoKey} for the same rationale.
 */
export function requireRunDir(args: Record<string, unknown>, tool: string): string {
  const s = args['runDir'];
  if (typeof s !== 'string' || s.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'runDir',
      message: `Tool '${tool}' requires a non-empty 'runDir' string in its input.`,
    });
  }
  // Reject NUL bytes outright — `path.normalize` accepts them and POSIX
  // syscalls would silently truncate.
  if (s.includes('\0')) {
    throw rejectRunDirShape(tool);
  }
  // Absolute + normalised: `..` segments and `\\` separators (on POSIX) are
  // rejected by the equality with `path.normalize`; Windows treats `\\` as
  // a separator but the runtime canonicalises POSIX-style separators by the
  // time the value reaches here.
  if (!path.isAbsolute(s) || path.normalize(s) !== s) {
    throw rejectRunDirShape(tool);
  }
  // Decompose against `<storeRoot>/<repoKey>/runs/<runId>` and refute any
  // value outside that layout. The store root is resolved per call (cheap;
  // env/marker lookups don't read disk).
  const storeRoot = resolveStoreRoot();
  const sep = path.sep;
  if (!(s === storeRoot || s.startsWith(storeRoot + sep))) {
    throw rejectRunDirShape(tool);
  }
  const tail = s.slice(storeRoot.length + 1); // drop leading separator
  const parts = tail.split(sep);
  // Expect exactly three components: <repoKey>/runs/<runId>.
  if (
    parts.length !== 3 ||
    parts[1] !== 'runs' ||
    !REPO_KEY_PATTERN.test(parts[0]) ||
    !RUN_ID_PATTERN.test(parts[2])
  ) {
    throw rejectRunDirShape(tool);
  }
  return s;
}

// Shared `runDir`-rejection error. Branched out so every refutation reads the
// same prose; the boundary surface stays one MalformedInput per check.
function rejectRunDirShape(tool: string): ConfigServerError {
  return createError('MalformedInput', {
    tool,
    field: 'runDir',
    message:
      `Tool '${tool}' requires 'runDir' to be an absolute, normalised path ` +
      `under the resolved store root, shaped as ` +
      `\`<storeRoot>/<repoKey>/runs/<runId>\` with the producer's repoKey and ` +
      `runId regexes; reject path traversal, relative paths, NUL, and any ` +
      `value outside the run-store layout at the wire boundary.`,
  });
}

// Extract a required event payload (any plain object) — the library
// overwrites `sequenceNumber` and validates against the trace schema on
// reconcile, so the boundary only enforces presence + shape (must be a
// non-array object).
function requireEventPayload(args: Record<string, unknown>, tool: string): Record<string, unknown> {
  const v = args['event'];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'event',
      message: `Tool '${tool}' requires an 'event' object in its input.`,
    });
  }
  return v as Record<string, unknown>;
}

// Extract a required non-empty `role` string for formatHeartbeat. The
// formatter accepts any string but the boundary rejects an empty role so
// the heartbeat line cannot widen into a confusing `[] thinking...`.
function requireRoleArg(args: Record<string, unknown>, tool: string): string {
  const s = args['role'];
  if (typeof s !== 'string' || s.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'role',
      message: `Tool '${tool}' requires a non-empty 'role' string in its input.`,
    });
  }
  return s;
}

// Extract the `metrics` object for formatLlmCallSummary — the formatter
// reads only the documented LlmCallMetrics fields, so any extra keys the
// caller mistakenly attaches (e.g. raw prompt text) are silently dropped
// by the formatter, preserving the metadata-only contract.
function requireMetricsArg(args: Record<string, unknown>, tool: string): Record<string, unknown> {
  const v = args['metrics'];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'metrics',
      message: `Tool '${tool}' requires a 'metrics' object in its input.`,
    });
  }
  // Cast to the typed shape downstream; the formatter only reads the
  // documented LlmCallMetrics fields and ignores extras.
  return v as Record<string, unknown>;
}

// Extract the `resolution` object for buildTrustEventBody. The downstream
// builder is a pure mapping; the boundary check is presence + shape.
function requireTrustResolutionArg(
  args: Record<string, unknown>,
  tool: string,
): Record<string, unknown> {
  const v = args['resolution'];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'resolution',
      message: `Tool '${tool}' requires a 'resolution' object in its input.`,
    });
  }
  return v as Record<string, unknown>;
}

// Extract the validation stage discriminant for the abort-body builders.
// The library accepts any string but the boundary documents the closed set.
function requireValidationStageArg(args: Record<string, unknown>, tool: string): string {
  const v = args['stage'];
  if (typeof v !== 'string' || v.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'stage',
      message: `Tool '${tool}' requires a non-empty 'stage' string in its input.`,
    });
  }
  return v;
}

// Extract the F2-like error object for buildValidationAbortBody.
function requireF2ErrorArg(args: Record<string, unknown>, tool: string): Record<string, unknown> {
  const v = args['error'];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'error',
      message: `Tool '${tool}' requires an 'error' object in its input.`,
    });
  }
  return v as Record<string, unknown>;
}

// Extract a required error-code string. The code is forwarded to
// createError, which validates it against the closed ErrorCode union; the
// boundary check is presence + string shape only.
function requireErrorCodeArg(args: Record<string, unknown>, tool: string): string {
  const v = args['code'];
  if (typeof v !== 'string' || v.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'code',
      message: `Tool '${tool}' requires a non-empty 'code' string in its input.`,
    });
  }
  return v;
}

// Read an optional error-details object for buildValidationAbortFromCode.
function optionalErrorDetailsArg(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const v = args['details'];
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

// Extract the LoopDetectionHalt object for buildLoopDetectedBody.
function requireLoopHaltArg(args: Record<string, unknown>, tool: string): Record<string, unknown> {
  const v = args['halt'];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'halt',
      message: `Tool '${tool}' requires a 'halt' object in its input.`,
    });
  }
  return v as Record<string, unknown>;
}

// Extract the `attemptStateByRole` map for checkSprintBudget. The library
// sums own keys via hasOwnProperty and skips forbidden-key entries; the
// boundary only asserts the input is a plain object so the library never sees
// a non-object value where it expects a map.
function requireAttemptStateByRoleArg(
  args: Record<string, unknown>,
  tool: string,
): Record<string, unknown> {
  const v = args['attemptStateByRole'];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'attemptStateByRole',
      message: `Tool '${tool}' requires an 'attemptStateByRole' object in its input.`,
    });
  }
  return v as Record<string, unknown>;
}

// Extract the fingerprint history array for detectEditOscillation. The
// library compares opaque fingerprint strings positionally; the boundary
// only asserts the input is an array so the library never sees a non-array
// where it expects a positional history.
function requireFingerprintHistoryArg(args: Record<string, unknown>, tool: string): unknown[] {
  const v = args['history'];
  if (!Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'history',
      message: `Tool '${tool}' requires a 'history' array in its input.`,
    });
  }
  return v;
}

// Extract the LoopDetectedFields object for the three error-builder tools.
// The library reads the documented fields verbatim and constructs the error;
// the boundary only asserts the input is a plain object so the library never
// sees a non-object where it expects structured halt fields.
function requireLoopDetectedFieldsArg(
  args: Record<string, unknown>,
  tool: string,
): Record<string, unknown> {
  const v = args['fields'];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: 'fields',
      message: `Tool '${tool}' requires a 'fields' object in its input.`,
    });
  }
  return v as Record<string, unknown>;
}

// Extract a required non-empty `traceDir` string for the three error-builder
// tools. traceDir is templated into the user-facing prose message; an empty
// path would render a confusing message and the boundary rejects it up front.
function requireTraceDirArg(args: Record<string, unknown>, tool: string): string {
  const v = args['traceDir'];
  if (typeof v !== 'string' || v.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'traceDir',
      message: `Tool '${tool}' requires a non-empty 'traceDir' string in its input.`,
    });
  }
  return v;
}

// Extract a required plain-object argument by name for the evaluator-plan
// tool. The downstream library reads its three structured inputs
// (snapshot, sprintPlan, worktreeState) by field; an array or non-object
// value at the boundary would otherwise reach the library and surface as a
// harder-to-trace failure, so the wrapper asserts the shape up front.
function requirePlanObjectArg(
  args: Record<string, unknown>,
  tool: string,
  fieldName: string,
): Record<string, unknown> {
  const v = args[fieldName];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw createError('MalformedInput', {
      tool,
      field: fieldName,
      message: `Tool '${tool}' requires a '${fieldName}' object in its input.`,
    });
  }
  return v as Record<string, unknown>;
}

// Extract a required worktreePath string, constrained to an absolute,
// normalised path. The library canonicalises internally and `PortRegistry`
// uses this value both as the registry *key* and (downstream, via the
// constructor's projectRoot) as the directory from which the repo-scoped
// module-state store is addressed — so an unconstrained value is two trust
// assumptions, not one:
//
//   - A blank or relative worktree key would collapse distinct workspaces
//     into one registry slot, or vary the store address per call so the
//     cross-worktree `PortInUse` collision check never fires.
//   - A `..`/traversal or NUL-bearing value could steer the store address
//     away from the worktree's real repo root.
//
// Requiring an absolute, already-normalised path (no `..` segments, no NUL)
// refutes both up front. The repo-key derivation that follows downstream
// still anchors the store to the worktree's real common git dir, so two
// worktrees of one repo share one registry; this boundary only refuses the
// shapes that would let a caller dodge that anchoring. Returns the value
// unchanged for the library to canonicalise.
//
// Exported so the boundary check can be exercised directly in unit tests —
// see {@link requireRepoKey} for the same rationale.
export function requireWorktreePathArg(args: Record<string, unknown>, tool: string): string {
  const v = args['worktreePath'];
  if (typeof v !== 'string' || v.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'worktreePath',
      message: `Tool '${tool}' requires a non-empty 'worktreePath' string in its input.`,
    });
  }
  assertWorktreePathShape(v, tool);
  return v;
}

// Refute a worktreePath that is relative, non-normalised, or NUL-bearing —
// the shapes that would let a caller redirect the registry's module-state
// store away from the worktree's real repo. Shared so `dockerDiscoverPort`
// (which reads `worktreePath` inline) can apply the same guard.
function assertWorktreePathShape(v: string, tool: string): void {
  if (v.includes('\0') || !path.isAbsolute(v) || path.normalize(v) !== v) {
    throw createError('MalformedInput', {
      tool,
      field: 'worktreePath',
      message:
        `Tool '${tool}' requires 'worktreePath' to be an absolute, normalised ` +
        `path with no '..' segments or NUL bytes, so it cannot redirect the ` +
        `port registry's module-state store away from the worktree's repo.`,
    });
  }
}

// Extract a required integer-shaped port in the valid host-port range. A
// fractional or out-of-range value is rejected at the boundary so the
// library never sees a value it cannot honour as a TCP port.
function requirePortArg(args: Record<string, unknown>, tool: string): number {
  const v = args['port'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 65535) {
    throw createError('MalformedInput', {
      tool,
      field: 'port',
      message: `Tool '${tool}' requires an integer 'port' in 0..65535.`,
    });
  }
  return v;
}

// Extract a required non-empty containerName string. The library's
// PortRegistry stores this string verbatim; the boundary rejects empty
// strings so a registry entry never carries an unusable name.
function requireContainerNameArg(args: Record<string, unknown>, tool: string): string {
  const v = args['containerName'];
  if (typeof v !== 'string' || v.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'containerName',
      message: `Tool '${tool}' requires a non-empty 'containerName' string in its input.`,
    });
  }
  return v;
}

// Extract a required HTTP path string for the health check, constrained so it
// can only address a path on the fixed localhost origin the library builds.
// The path is consumed downstream as the relative-reference argument to the
// WHATWG `URL` constructor against a `http://127.0.0.1:<port>` base; a value
// that does not begin with a single `/` (e.g. `@evil.tld/x`, `//evil.tld`, or
// a scheme-relative `http:...`) can relocate the resolved host away from
// localhost, turning the probe into an SSRF primitive. Control bytes and
// whitespace (`\r`, `\n`, space, tab) and the `?`/`#` delimiters likewise
// desync URL parsing. The boundary rejects all of these so only a genuine
// path-absolute reference reaches the library.
//
// Exported so the boundary check can be exercised directly in unit tests —
// see {@link requireRepoKey} for the same rationale.
export function requireHttpPathArg(args: Record<string, unknown>, tool: string): string {
  const v = args['path'];
  if (typeof v !== 'string' || v.length === 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'path',
      message: `Tool '${tool}' requires a non-empty 'path' string in its input.`,
    });
  }
  // Must be path-absolute (a single leading slash) but not protocol- or
  // scheme-relative (`//host` resolves the authority, not the path).
  if (v[0] !== '/' || v[1] === '/') {
    throw rejectHttpPathShape(tool);
  }
  // Reject any C0 control byte (U+0000-U+001F), DEL (U+007F), space, and
  // the `?`/`#` delimiters that would carry the request off the path
  // component or desync URL parsing.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F ?#]/.test(v)) {
    throw rejectHttpPathShape(tool);
  }
  return v;
}

// Shared rejection for a health-check `path` that could escape the fixed
// localhost origin or desync URL parsing.
function rejectHttpPathShape(tool: string): ConfigServerError {
  return createError('MalformedInput', {
    tool,
    field: 'path',
    message:
      `Tool '${tool}' requires 'path' to be a localhost-relative request path: ` +
      `a single leading '/', no scheme-relative '//' prefix, and no control ` +
      `bytes, whitespace, '?', or '#'. This keeps the health probe pinned to ` +
      `the localhost origin and prevents the URL from being redirected.`,
  });
}

// Extract a required integer HTTP status code. The library compares this to
// the live response's `status`, which is itself integer-typed; pinning the
// type at the boundary prevents an accidental string from silently failing
// every equality check inside the polling loop.
function requireExpectStatusArg(args: Record<string, unknown>, tool: string): number {
  const v = args['expectStatus'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v > 599) {
    throw createError('MalformedInput', {
      tool,
      field: 'expectStatus',
      message: `Tool '${tool}' requires an integer 'expectStatus' in 100..599.`,
    });
  }
  return v;
}

// Extract a required non-negative finite timeout in seconds. A negative or
// non-finite budget would make the library's totalBudgetMs computation
// degenerate; the boundary pins the value at the same shape the library
// safely consumes.
function requireTimeoutSecondsArg(args: Record<string, unknown>, tool: string): number {
  const v = args['timeoutSeconds'];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw createError('MalformedInput', {
      tool,
      field: 'timeoutSeconds',
      message: `Tool '${tool}' requires a non-negative finite 'timeoutSeconds' number.`,
    });
  }
  return v;
}

// Require that `fieldName` is present (own key) and not `undefined`, returning
// its value, or throw MalformedInput. Unlike a type check this permits any
// value — including `null`/`false`/`0`/`""` — so a deliberate falsy payload is
// accepted; only a truly missing/undefined one is rejected.
function requirePresentValue(
  args: Record<string, unknown>,
  tool: string,
  fieldName: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(args, fieldName) || args[fieldName] === undefined) {
    throw createError('MalformedInput', {
      tool,
      field: fieldName,
      message: `Tool '${tool}' requires a '${fieldName}' payload in its input.`,
    });
  }
  return args[fieldName];
}

// Read the optional `duplicatePolicy` argument. Returns undefined when absent
// (the impl applies its own default); the raw value is passed through
// unvalidated for the impl to range-check.
function optionalDuplicatePolicy(args: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(args, 'duplicatePolicy')) return undefined;
  return args['duplicatePolicy'];
}

/**
 * Redact tool arguments to a log-safe summary.
 *
 * Sensitive payloads (`value`, `state`, `manifest`) are reduced to a shape
 * descriptor; secret-bearing keys (`contentHash`/`trustHash`/`hash`, plus
 * `key`/`entryKey`, which can themselves be sensitive identifiers) become mere
 * presence booleans; only the non-sensitive routing args
 * (`projectRoot`/`name`/`tier`/`fieldPath`) are logged verbatim. Any other key
 * is summarised by shape. This is the mechanism behind the module-level
 * guarantee that no config content reaches a log.
 *
 * @returns a new object safe to embed in a log entry.
 */
function anonymiseToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    if (k === 'value') {
      out['valueShape'] = describeRedactedShape(args[k]);
      continue;
    }
    if (k === 'state') {
      out['stateShape'] = describeRedactedShape(args[k]);
      continue;
    }
    if (k === 'manifest') {
      out['manifestShape'] = describeRedactedShape(args[k]);
      continue;
    }
    if (k === 'contentHash' || k === 'trustHash' || k === 'hash') {
      out['hashPresent'] = typeof args[k] === 'string';
      continue;
    }
    if (k === 'key') {
      out['keyPresent'] = typeof args[k] === 'string';
      continue;
    }
    if (k === 'entryKey') {
      out['entryKeyPresent'] = typeof args[k] === 'string';
      continue;
    }
    if (k === 'projectRoot' || k === 'name' || k === 'tier' || k === 'fieldPath') {
      out[k] = args[k];
      continue;
    }

    out[`${k}Shape`] = describeRedactedShape(args[k]);
  }
  return out;
}

// Describe a value's shape for logging without revealing its contents: null /
// undefined are named, arrays report only their length, everything else
// reports its `typeof`. Never emits the actual value.
function describeRedactedShape(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `array(len=${v.length})`;
  return typeof v;
}

// Read the optional `contentHash` argument (string only, else undefined). Note
// the write impl recomputes the hash from disk and does not trust this value;
// it is accepted for callers that wish to assert the hash they observed.
function optionalContentHash(args: Record<string, unknown>): string | undefined {
  const v = args['contentHash'];
  return typeof v === 'string' ? v : undefined;
}

// Read the optional trust-approval `note` (non-empty string only). An empty
// string is treated as absent so a blank note is never persisted.
function optionalNote(args: Record<string, unknown>): string | undefined {
  const v = args['note'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Run the server in MCP stdio mode: create the server, connect it over
 * stdin/stdout, and resolve only when stdin closes/ends (i.e. the client
 * disconnects), keeping the process alive for the session in between.
 */
export async function runStdio(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve) => {
    process.stdin.on('close', () => resolve());
    process.stdin.on('end', () => resolve());
  });
}

/**
 * CLI entry point. Dispatches on argv:
 * - `--version` → print the package version and return.
 * - `--validate-all` → validate the cwd; print issues and `process.exit(1)`
 *   when any exist (so the command is usable as a CI gate), else print a clean
 *   line and return.
 * - otherwise → fall through to {@link runStdio} (MCP server mode).
 */
export async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--version')) {
    const meta = await readPackageMeta();
    process.stdout.write(meta.version + '\n');
    return;
  }

  if (argv.includes('--validate-all')) {
    const { issues } = runValidateAll({ projectRoot: process.cwd() });
    if (issues.length === 0) {
      process.stdout.write('validate-all: no issues\n');
      return;
    }
    process.stdout.write(`validate-all: ${issues.length} issue(s)\n`);
    for (const i of issues) {
      const where = i.path ? ` ${i.path}` : '';
      const field = i.field ? ` ${i.field}` : '';
      process.stdout.write(`  [${i.code}]${where}${field}: ${i.message}\n`);
    }
    process.exit(1);
  }

  await runStdio();
}

// True when this module is the process entry point (run directly as the bin),
// as opposed to being imported by another module or a test. Computed once at
// load time by comparing this module's own file to argv[1]. Both sides are
// passed through realpathSync so a symlinked bin (the common npm install shape)
// still matches its real target; if either realpath fails the pre-resolved
// path is used as the fallback. Guards the auto-run block below so importing
// the module never starts the server.
const invokedAsBin = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    const here = fileURLToPath(import.meta.url);
    let entry = path.resolve(process.argv[1]);
    try {
      entry = realpathSync(entry);
    } catch {
      // Leave entry as path.resolve(process.argv[1]).
    }
    let canonicalHere = here;
    try {
      canonicalHere = realpathSync(here);
    } catch {
      // Leave canonicalHere as fileURLToPath(import.meta.url).
    }
    return entry === canonicalHere;
  } catch {
    return false;
  }
})();

// Auto-run only when invoked as the bin. A fatal error is reported as a single
// JSON line on stderr and exits non-zero, so even startup failures are
// machine-readable rather than an unhandled rejection.
if (invokedAsBin) {
  runCli().catch((e) => {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        msg: 'config-server-fatal',
        error: e instanceof Error ? e.message : String(e),
      }) + '\n',
    );
    process.exit(1);
  });
}
