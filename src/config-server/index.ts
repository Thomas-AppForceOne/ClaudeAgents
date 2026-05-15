#!/usr/bin/env node
/**
 * @claudeagents/config-server — MCP server bootstrap.
 *
 * Registers handlers for every F2 tool name. Reads are wired in S2 — see
 * `tools/reads.ts`. The three validate tools (`validateAll`,
 * `validateStack`, `validateOverlay`) were wired in S3 — see
 * `tools/validate.ts`. Writes are wired in S6 — see `tools/writes.ts`.
 * The two reads deferred past S2 (`getStackConventions`,
 * `getOverlayField`) still throw `NotImplemented` via the central error
 * factory; they ship in a later sprint. Trust writes ship as OQ1
 * loud-stubs (R5 lands real trust); module writes are no-ops (M1 lands
 * real modules).
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

/** F2 tool names. The list is deliberately exhaustive; see `apiToolsV1`. */
export const F2_TOOL_NAMES: readonly string[] = [
  // Reads
  'getApiVersion',
  'getResolvedConfig',
  'getStack',
  'getStackConventions',
  'getActiveStacks',
  'getOverlay',
  'getOverlayField',
  'getMergedSplicePoints',
  'getStackResolution',
  'getTrustState',
  'getTrustDiff',
  'getModuleState',
  'listModules',
  // Writes
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
  // Validate
  'validateAll',
  'validateStack',
  'validateOverlay',
] as const;

/**
 * R5 sprint 4 dispatch additions. `trustList` is a new MCP tool that
 * post-dates F2's tool-list freeze; it is dispatched but not part of
 * the F2 schema (which the JSON schema document at `schemas/api-tools-
 * v1.json` codifies). Keeping the two lists separate preserves the
 * F2-schema-vs-MCP-dispatch invariant while still routing `trustList`
 * through the wrapper.
 */
export const R5_TOOL_NAMES: readonly string[] = ['trustList'] as const;

/** Union of every dispatchable tool name (F2 + R5 additions). */
export const DISPATCH_TOOL_NAMES: readonly string[] = [...F2_TOOL_NAMES, ...R5_TOOL_NAMES];

interface PackageMeta {
  name: string;
  version: string;
}

let cachedMeta: PackageMeta | null = null;

/**
 * Read the package.json at build/runtime to recover the server's name and
 * semver. Reads from the package root located via the shared `packageRoot()`
 * helper (which walks up from `import.meta.url` and verifies the package
 * name).
 */
export async function readPackageMeta(): Promise<PackageMeta> {
  if (cachedMeta) return cachedMeta;
  const pkgPath = path.join(resolvePackageRoot(), 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as PackageMeta;
  cachedMeta = { name: parsed.name, version: parsed.version };
  return cachedMeta;
}

/** Direct library entry point for `getApiVersion`. */
export async function getApiVersion(): Promise<{ apiVersion: string }> {
  const meta = await readPackageMeta();
  return { apiVersion: meta.version };
}

/**
 * One entry in the introspection list. Carries both the schema's
 * `inputSchema` (the documented contract) and the runtime's `required`
 * declaration (the dispatched contract). F5 § Parameter-shape
 * consistency uses the pair to assert alignment: a contract test
 * (see `tests/config-server/integration/f5-coherence.test.ts`) iterates
 * this list and asserts `entry.required` matches
 * `entry.inputSchema.required` for every advertised tool — without
 * needing any export that exists only to support tests.
 */
export interface ToolListEntry {
  name: string;
  description: string;
  /** Runtime-required input fields per the dispatch handler's spec. */
  required: readonly string[];
  /** Schema-declared input shape from `schemas/api-tools-v1.json`. */
  inputSchema: Record<string, unknown>;
}

/**
 * Build the introspection list of every wired tool. Returns one entry
 * per F2 tool whose runtime dispatch is actually implemented — tools
 * that ship as `NotImplemented` stubs in this release are simply absent
 * from `TOOL_HANDLERS` and therefore absent from the returned list.
 *
 * F5 slice 1 contract: the filter is keyed off `TOOL_HANDLERS`. When a
 * future release wires a previously-NotImplemented tool by adding a
 * handler spec, the tool appears in this list (and therefore in MCP
 * `tools/list`) with no other code change required.
 *
 * The MCP `tools/list` payload is a strict projection of this result:
 * see `createMcpServer` for the `{name, description, inputSchema}`
 * subset MCP clients receive.
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

/** Construct and return a configured MCP `Server` ready to be connected. */
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
    // MCP `tools/list` payload only needs the client-facing fields;
    // the runtime-`required` declaration on each entry is internal to
    // the framework's introspection surface. (It rides inside
    // `inputSchema.required` for clients that validate.)
    const tools = buildToolList().map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

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
      logger.info('tools/call: start', {
        tool: toolName,
        anonymisedArgs: anonymiseToolArgs(args),
      });
      const result = await dispatchRead(toolName, args, logger);
      if (result !== UNHANDLED) {
        logger.info('tools/call: ok', { tool: toolName, code: 'OK' });
        return successResponse(result);
      }

      // Tools not yet wired (getStackConventions, getOverlayField) remain
      // `NotImplemented` until their owning sprints land.
      throw createError('NotImplemented', { tool: toolName });
    } catch (e) {
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

function successResponse(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function errorResponse(err: ConfigServerError): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }],
    isError: true,
  };
}

/** Sentinel returned by `dispatchRead` when the named tool is not handled. */
const UNHANDLED = Symbol('unhandled');
type Unhandled = typeof UNHANDLED;

/** Per-dispatch context passed to every handler. */
interface HandlerContext {
  logger: ReturnType<typeof getLogger>;
}

/**
 * One wired tool: takes the raw arguments dict (validated inside the
 * handler via the `require*` helpers) plus a logger context, returns
 * the tool's structured result. Handlers may be sync or async; the
 * dispatch wrapper awaits them uniformly.
 */
type ToolHandler = (
  args: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<unknown> | unknown;

/**
 * A single tool's full dispatch spec — the runtime contract co-located
 * with the runtime implementation. `required` lists the input fields
 * the handler will reject as missing (via the `require*` helpers); it
 * is the authoritative answer to "what does the runtime require?", and
 * `buildToolList` surfaces it on every entry so the documented schema
 * (`schemas/api-tools-v1.json`) can be verified against the same
 * structure that drives dispatch.
 */
interface ToolHandlerSpec {
  readonly required: readonly string[];
  readonly handler: ToolHandler;
}

/**
 * The single source of truth for which F2 / R5 tools the MCP server
 * actually serves. F5 slice 1: a tool's presence in this table ⇔
 * `tools/list` advertises it AND `dispatchRead` honours it. A tool
 * whose runtime is not implemented yet is absent here; `buildToolList`
 * filters it out automatically (so MCP clients never see a tool they
 * cannot call) and `dispatchRead` returns `UNHANDLED` for it, which
 * the MCP wrapper converts to `NotImplemented`. When v1.1 ships
 * `getOverlayField` or `getStackConventions`, the only change required
 * is adding the matching entry here — no edits in `buildToolList`, no
 * denylist to maintain.
 *
 * Each entry carries its `required` field list alongside its handler;
 * the two are co-located so the runtime contract cannot drift from the
 * implementation. `buildToolList` exposes the `required` declaration
 * on every entry so the schema-runtime parity test can read both
 * sides from the same surface.
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
      // The library's `appendToModuleState` validates `duplicatePolicy`
      // itself (throws `MalformedInput` on unknown strings) so the
      // dispatcher passes the raw value through and the validation stays
      // single-sourced.
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

/**
 * Dispatch a tool call. Returns the wired handler's result, or the
 * `UNHANDLED` sentinel for any tool name that has no entry in
 * `TOOL_HANDLERS`. The MCP wrapper turns `UNHANDLED` into a
 * `NotImplemented` error. Input validation throws via
 * `createError('MalformedInput', …)` from inside each handler and is
 * caught upstream.
 */
async function dispatchRead(
  toolName: string,
  args: Record<string, unknown>,
  logger: ReturnType<typeof getLogger>,
): Promise<unknown | Unhandled> {
  const spec = TOOL_HANDLERS[toolName];
  if (spec === undefined) return UNHANDLED;
  return spec.handler(args, { logger });
}

/** Validate that `fieldPath` is a non-empty string; throw `MalformedInput` otherwise. */
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

/**
 * Validate that `key` is a non-empty string; throw `MalformedInput`
 * otherwise. Used by the four module-state tools (M3 per-key
 * contract). The allowlist gate against the manifest's `stateKeys`
 * happens downstream — this helper only checks shape.
 */
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

/**
 * Validate that `entryKey` is a non-empty string; throw
 * `MalformedInput` otherwise. Used by `removeFromModuleState`'s
 * keyed-lookup contract (M3): the function removes by map property
 * name (for map-shaped state) or by `key` field (for list-of-`{key,
 * …}`-shaped state). The on-disk shape check happens downstream.
 */
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

function readValue(args: Record<string, unknown>, key: string = 'value'): unknown {
  return args[key];
}

/**
 * Validate that a payload field (`value`, `state`, etc.) is present in
 * the input. Distinct from `readValue` because the write-class tools
 * MUST receive a payload — passing `undefined` would otherwise
 * silently propagate into the on-disk shape. Throws `MalformedInput`
 * with a structured `field` so callers (including the schema-runtime
 * parity test) can match the missing field by name.
 */
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

/**
 * Read an optional `duplicatePolicy` argument and pass through any
 * recognised string verbatim. Unknown strings (and non-string
 * values) are returned as-is so the downstream library function
 * can throw `MalformedInput` consistently — keeping the validation
 * single-sourced inside `appendToModuleState`. `undefined` (the
 * absent-key case) is returned untouched so the library default
 * applies.
 */
function optionalDuplicatePolicy(args: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(args, 'duplicatePolicy')) return undefined;
  return args['duplicatePolicy'];
}

/**
 * Build an anonymised view of the tool's input arguments suitable for the
 * per-call start log. Per F4 + the centralised log-routing rule, we never
 * echo `value` payloads, overlay contents, trust hashes, or `manifest`
 * blobs. We log only field *names* (the safe metadata) plus identifiers
 * the user already shares (`projectRoot`, `name`, `tier`, `fieldPath`).
 *
 * The forbidden-key set in `logger.sanitiseMeta` only strips *top-level*
 * meta keys (e.g. a stray `value` passed alongside `tool`), so we
 * deliberately rebrand the anonymised slots here: the redacted
 * description is keyed under `valueShape` / `manifestShape` / etc., never
 * `value` / `manifest` / `state` / `trustHash` / `contentHash`. This way
 * even if a downstream consumer flattens the anonymisedArgs dict, the
 * redacted entries cannot collide with the forbidden top-level names.
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
      // Module-state `key` is user-defined (declared in a module's
      // manifest `stateKeys` allowlist). Treat it as opaque in logs —
      // a module author may legitimately name keys after internal
      // namespaces, and the per-run log line should not echo those
      // strings. Echo presence only, never the raw value.
      out['keyPresent'] = typeof args[k] === 'string';
      continue;
    }
    if (k === 'entryKey') {
      // Same reasoning as `key`: caller-supplied string used to address
      // a slot within module state. Echo presence only.
      out['entryKeyPresent'] = typeof args[k] === 'string';
      continue;
    }
    if (k === 'projectRoot' || k === 'name' || k === 'tier' || k === 'fieldPath') {
      out[k] = args[k];
      continue;
    }
    // Unknown keys: echo presence only, never the raw value. Rename to
    // `<key>Shape` so this branch can never resurrect a forbidden name.
    out[`${k}Shape`] = describeRedactedShape(args[k]);
  }
  return out;
}

function describeRedactedShape(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `array(len=${v.length})`;
  return typeof v;
}

function optionalContentHash(args: Record<string, unknown>): string | undefined {
  const v = args['contentHash'];
  return typeof v === 'string' ? v : undefined;
}

function optionalNote(args: Record<string, unknown>): string | undefined {
  const v = args['note'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Run the server over stdio. Resolves when stdin closes. */
export async function runStdio(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Resolve cleanly when stdin ends, so the process exits.
  await new Promise<void>((resolve) => {
    process.stdin.on('close', () => resolve());
    process.stdin.on('end', () => resolve());
  });
}

/**
 * CLI dispatch. With no recognised flag, runs as an MCP server over
 * stdio. Recognised short-circuits:
 *
 *   --version        Print the package version and exit 0.
 *   --validate-all   Run the full validation pipeline against `cwd` and
 *                    exit 0 (no issues) or 1 (one or more issues).
 *
 * `install.sh` invokes both as short-circuit probes; their absence here
 * caused the binary to enter MCP mode and block on stdin, which appeared
 * as an install hang on TTY (see install.sh `version_probe_mcp` /
 * `run_validate_all_best_effort`).
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

const invokedAsBin = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    // `process.argv[1]` may be a symlink (npm bin shims always are), so
    // `path.resolve` alone is not enough — Node's module loader resolves
    // `import.meta.url` to the realpath, which means a naive
    // path-equality check returns `false` for every symlinked invocation
    // and the server silently exits without ever starting. `realpathSync`
    // on both sides equalises the comparison.
    //
    // If realpath fails (file missing, permissions), fall back to the
    // path.resolve form — it's no worse than the original.
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
