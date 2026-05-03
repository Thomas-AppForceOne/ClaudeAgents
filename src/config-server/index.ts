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
 * Build an MCP `tools/list` payload from the bundled `api-tools-v1` schema.
 * The shape: each tool has a `name`, a `description`, and an `inputSchema`
 * (a JSON Schema object). MCP clients use this to validate tool calls.
 */
export function buildToolList(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const props = (apiToolsV1.properties ?? {}) as Record<string, { inputSchema?: unknown }>;
  return F2_TOOL_NAMES.map((name) => {
    const entry = props[name];
    const inputSchema =
      entry && typeof entry === 'object' && entry.inputSchema
        ? (entry.inputSchema as Record<string, unknown>)
        : { type: 'object', additionalProperties: false, properties: {} };
    return {
      name,
      description: `ClaudeAgents config-server tool: ${name}`,
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
    return { tools: buildToolList() };
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

/**
 * Dispatch every wired F2 tool — reads (S2 + S5), writes (S6), and the
 * three validate paths (S3 + S4). Returns the tool result, or the
 * `UNHANDLED` sentinel for the two reads still deferred past S2
 * (`getStackConventions` / `getOverlayField`); the caller turns
 * `UNHANDLED` into a `NotImplemented` error. Input validation throws via
 * `createError('MalformedInput', …)` and is caught upstream.
 */
async function dispatchRead(
  toolName: string,
  args: Record<string, unknown>,
  logger: ReturnType<typeof getLogger>,
): Promise<unknown | Unhandled> {
  switch (toolName) {
    case 'getApiVersion': {
      return getApiVersion();
    }
    case 'getResolvedConfig': {
      const projectRoot = requireProjectRoot(args, toolName);
      return readGetResolvedConfig({ projectRoot });
    }
    case 'getStack': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      return readGetStack({ projectRoot, name });
    }
    case 'getActiveStacks': {
      const projectRoot = requireProjectRoot(args, toolName);
      return readGetActiveStacks({ projectRoot });
    }
    case 'getOverlay': {
      const projectRoot = requireProjectRoot(args, toolName);
      const tier = requireOverlayTier(args, toolName);
      return readGetOverlay({ projectRoot, tier });
    }
    case 'getMergedSplicePoints': {
      const projectRoot = requireProjectRoot(args, toolName);
      return readGetMergedSplicePoints({ projectRoot });
    }
    case 'getStackResolution': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      return readGetStackResolution({ projectRoot, name });
    }
    case 'getTrustState': {
      const projectRoot = requireProjectRoot(args, toolName);
      return readGetTrustState({ projectRoot }, { logger });
    }
    case 'getTrustDiff': {
      const projectRoot = requireProjectRoot(args, toolName);
      return readGetTrustDiff({ projectRoot }, { logger });
    }
    case 'trustList': {
      return readTrustList({}, { logger });
    }
    case 'getModuleState': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      return readGetModuleState({ projectRoot, name });
    }
    case 'listModules': {
      const projectRoot = requireProjectRoot(args, toolName);
      return readListModules({ projectRoot });
    }
    case 'validateAll': {
      const projectRoot = requireProjectRoot(args, toolName);
      return runValidateAll({ projectRoot });
    }
    case 'validateStack': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      return runValidateStack({ projectRoot, name });
    }
    case 'validateOverlay': {
      const projectRoot = requireProjectRoot(args, toolName);
      const tier = requireOverlayTier(args, toolName);
      return runValidateOverlay({ projectRoot, tier });
    }
    case 'setOverlayField': {
      const projectRoot = requireProjectRoot(args, toolName);
      const tier = requireOverlayTier(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runSetOverlayField({ projectRoot, tier, fieldPath, value });
    }
    case 'appendToOverlayField': {
      const projectRoot = requireProjectRoot(args, toolName);
      const tier = requireOverlayTier(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runAppendToOverlayField({ projectRoot, tier, fieldPath, value });
    }
    case 'removeFromOverlayField': {
      const projectRoot = requireProjectRoot(args, toolName);
      const tier = requireOverlayTier(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runRemoveFromOverlayField({ projectRoot, tier, fieldPath, value });
    }
    case 'updateStackField': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runUpdateStackField({ projectRoot, name, fieldPath, value });
    }
    case 'appendToStackField': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runAppendToStackField({ projectRoot, name, fieldPath, value });
    }
    case 'removeFromStackField': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runRemoveFromStackField({ projectRoot, name, fieldPath, value });
    }
    case 'trustApprove': {
      const projectRoot = requireProjectRoot(args, toolName);
      const contentHash = optionalContentHash(args);
      const note = optionalNote(args);
      return runTrustApprove({ projectRoot, contentHash, note }, { logger });
    }
    case 'trustRevoke': {
      const projectRoot = requireProjectRoot(args, toolName);
      return runTrustRevoke({ projectRoot }, { logger });
    }
    case 'setModuleState': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      const state = readValue(args, 'state');
      return runSetModuleState({ projectRoot, name, state });
    }
    case 'appendToModuleState': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runAppendToModuleState({ projectRoot, name, fieldPath, value });
    }
    case 'removeFromModuleState': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      const fieldPath = requireFieldPath(args, toolName);
      const value = readValue(args);
      return runRemoveFromModuleState({ projectRoot, name, fieldPath, value });
    }
    case 'registerModule': {
      const projectRoot = requireProjectRoot(args, toolName);
      const name = requireName(args, toolName);
      const manifest = readValue(args, 'manifest');
      return runRegisterModule({ projectRoot, name, manifest });
    }
    default:
      return UNHANDLED;
  }
}

/** Validate that `fieldPath` is a non-empty string; throw `MalformedInput` otherwise. */
function requireFieldPath(args: Record<string, unknown>, tool: string): string {
  const fp = args['fieldPath'];
  if (typeof fp !== 'string' || fp.length === 0) {
    throw createError('MalformedInput', {
      tool,
      message: `Tool '${tool}' requires a non-empty 'fieldPath' string in its input.`,
    });
  }
  return fp;
}

function readValue(args: Record<string, unknown>, key: string = 'value'): unknown {
  return args[key];
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

const invokedAsBin = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    const entry = path.resolve(process.argv[1]);
    const here = fileURLToPath(import.meta.url);
    return entry === here;
  } catch {
    return false;
  }
})();

if (invokedAsBin) {
  runStdio().catch((e) => {
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
