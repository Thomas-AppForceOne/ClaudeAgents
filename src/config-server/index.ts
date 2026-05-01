#!/usr/bin/env node
/**
 * @claudeagents/config-server — MCP server bootstrap (R1 sprint 1 skeleton).
 *
 * Registers a stub handler for every F2 tool name. Only `getApiVersion`
 * returns real data (the package's semver, read from `package.json`); every
 * other tool throws `NotImplemented` via the central error factory. Real
 * read paths land in S2; trust + module surfaces ship as loud-stubs in S2;
 * write paths land in S3+; invariants in S4; resolution in S5+.
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
      if (toolName === 'getApiVersion') {
        const result = await getApiVersion();
        logger.info('tools/call: ok', { tool: toolName, code: 'OK' });
        return successResponse(result);
      }

      // Every other tool is a sprint-1 stub.
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
