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
 * Every tool name the dispatcher will accept (F2 ∪ R5). A `tools/call` for a
 * name outside this set is rejected as an unknown tool. Note this is a superset
 * of the *advertised* list — advertising additionally requires a registered
 * handler (see {@link buildToolList}).
 */
export const DISPATCH_TOOL_NAMES: readonly string[] = [...F2_TOOL_NAMES, ...R5_TOOL_NAMES];

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
  const props = (apiToolsV1.properties ?? {}) as Record<string, { inputSchema?: unknown }>;
  return F2_TOOL_NAMES.filter((name) =>
    Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name),
  ).map((name) => {
    const schemaEntry = props[name];
    const inputSchema =
      schemaEntry && typeof schemaEntry === 'object' && schemaEntry.inputSchema
        ? (schemaEntry.inputSchema as Record<string, unknown>)
        : { type: 'object', additionalProperties: false, properties: {} };
    return {
      name,
      description: `ClaudeAgents config-server tool: ${name}`,
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

// Read an optional argument as-is, without presence/type validation
// (defaults to the `value` key). Used for payloads the impl validates itself,
// e.g. a module manifest.
function readValue(args: Record<string, unknown>, key: string = 'value'): unknown {
  return args[key];
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
