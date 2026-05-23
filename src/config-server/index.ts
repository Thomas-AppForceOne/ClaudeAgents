#!/usr/bin/env node

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

export const R5_TOOL_NAMES: readonly string[] = ['trustList'] as const;

export const DISPATCH_TOOL_NAMES: readonly string[] = [...F2_TOOL_NAMES, ...R5_TOOL_NAMES];

interface PackageMeta {
  name: string;
  version: string;
}

let cachedMeta: PackageMeta | null = null;

export async function readPackageMeta(): Promise<PackageMeta> {
  if (cachedMeta) return cachedMeta;
  const pkgPath = path.join(resolvePackageRoot(), 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as PackageMeta;
  cachedMeta = { name: parsed.name, version: parsed.version };
  return cachedMeta;
}

export async function getApiVersion(): Promise<{ apiVersion: string }> {
  const meta = await readPackageMeta();
  return { apiVersion: meta.version };
}

export interface ToolListEntry {
  name: string;
  description: string;

  required: readonly string[];

  inputSchema: Record<string, unknown>;
}

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

const UNHANDLED = Symbol('unhandled');
type Unhandled = typeof UNHANDLED;

interface HandlerContext {
  logger: ReturnType<typeof getLogger>;
}

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<unknown> | unknown;

interface ToolHandlerSpec {
  readonly required: readonly string[];
  readonly handler: ToolHandler;
}

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

async function dispatchRead(
  toolName: string,
  args: Record<string, unknown>,
  logger: ReturnType<typeof getLogger>,
): Promise<unknown | Unhandled> {
  const spec = TOOL_HANDLERS[toolName];
  if (spec === undefined) return UNHANDLED;
  return spec.handler(args, { logger });
}

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

function optionalDuplicatePolicy(args: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(args, 'duplicatePolicy')) return undefined;
  return args['duplicatePolicy'];
}

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

export async function runStdio(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve) => {
    process.stdin.on('close', () => resolve());
    process.stdin.on('end', () => resolve());
  });
}

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
