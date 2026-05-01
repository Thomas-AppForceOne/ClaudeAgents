#!/usr/bin/env node
/**
 * @claudeagents/config-server — MCP server bootstrap.
 *
 * Registers handlers for every F2 tool name. Reads are wired in S2 — see
 * `tools/reads.ts` for direct-library entry points. The three validate
 * tools (`validateAll`, `validateStack`, `validateOverlay`) are wired in
 * S3 — see `tools/validate.ts`. Writes and the two reads deferred past
 * S2 (`getStackConventions`, `getOverlayField`) still throw
 * `NotImplemented` via the central error factory. Trust reads ship as
 * loud-stubs (R5 lands real trust); module reads are no-ops (M1 lands
 * real modules). Real cascade and dispatch lands in S5; cross-file
 * invariants (validateAll's phase 3) in S4; writes in S6.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createError, ConfigServerError } from './errors.js';
import { getLogger } from './logging/logger.js';
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
} from './tools/reads.js';
import {
  validateAll as runValidateAll,
  validateOverlay as runValidateOverlay,
  validateStack as runValidateStack,
} from './tools/validate.js';

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

interface PackageMeta {
  name: string;
  version: string;
}

let cachedMeta: PackageMeta | null = null;

/**
 * Read the package.json at build/runtime to recover the server's name and
 * semver. The `dist/config-server/index.js` lives two levels under the
 * package root, so we walk up from `__dirname`.
 */
export async function readPackageMeta(): Promise<PackageMeta> {
  if (cachedMeta) return cachedMeta;
  const here = fileURLToPath(import.meta.url);
  // From `dist/config-server/index.js` → `<root>` is two levels up.
  // From `src/config-server/index.ts` (ts-node / vitest) → also two levels up.
  const pkgPath = path.resolve(path.dirname(here), '..', '..', 'package.json');
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

    if (!F2_TOOL_NAMES.includes(toolName)) {
      const err = createError('MalformedInput', {
        tool: toolName,
        message: `Unknown tool '${toolName}'.`,
      });
      logger.warn('tools/call: unknown tool', { tool: toolName, code: err.code });
      return errorResponse(err);
    }

    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await dispatchRead(toolName, args, logger);
      if (result !== UNHANDLED) {
        logger.info('tools/call: ok', { tool: toolName, code: 'OK' });
        return successResponse(result);
      }

      // Tools not yet wired (writes, getStackConventions, getOverlayField)
      // remain `NotImplemented` until their owning sprints land.
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
 * Dispatch the S2 read surface plus the S3 validate surface. Returns the
 * tool result, or the `UNHANDLED` sentinel for tool names this sprint
 * hasn't wired (writes, plus `getStackConventions` / `getOverlayField`
 * deferred past S2). Input validation throws via `createError(
 * 'MalformedInput', …)` and is caught upstream.
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
    default:
      return UNHANDLED;
  }
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
