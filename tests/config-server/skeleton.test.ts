import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createError, ConfigServerError } from '../../src/config-server/errors.js';
import {
  glob,
  canonicalizePath,
  stableStringify,
  localeSort,
} from '../../src/config-server/determinism/index.js';
import { getLogger } from '../../src/config-server/logging/logger.js';
import {
  buildToolList,
  DISPATCH_TOOL_NAMES,
  F2_TOOL_NAMES,
  getApiVersion,
  requireRepoKey,
  requireRunDir,
} from '../../src/config-server/index.js';
import { apiToolsV1, stackV1, overlayV1 } from '../../src/config-server/schemas-bundled.js';
import { resolveStoreRoot } from '../../src/config-server/storage/run-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

describe('getApiVersion', () => {
  it('returns a semver-shaped string read from package.json', async () => {
    const result = await getApiVersion();
    expect(result.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(result.apiVersion).toBe(pkg.version);
  });
});

describe('createError', () => {
  it('builds a NotImplemented error with the expected shape', () => {
    const err = createError('NotImplemented', { tool: 'foo' });
    expect(err).toBeInstanceOf(ConfigServerError);
    expect(err.code).toBe('NotImplemented');
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.message).toContain('foo');
    const json = err.toJSON();
    expect(json.code).toBe('NotImplemented');
    expect(json.tool).toBe('foo');
  });

  it('honours each F2 error code', () => {
    const codes: Array<Parameters<typeof createError>[0]> = [
      'SchemaMismatch',
      'InvalidYAML',
      'MissingFile',
      'UnknownStack',
      'UnknownSplicePoint',
      'InvariantViolation',
      'ValidationFailed',
      'UnknownApiVersion',
      'UntrustedOverlay',
      'TrustCacheCorrupt',
      'PathEscape',
      'NotImplemented',
      'MalformedInput',
      'CacheEnvConflict',
    ];
    for (const code of codes) {
      const err = createError(code);
      expect(err.code).toBe(code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

describe('determinism module', () => {
  it('glob matches and locale-sorts results', () => {
    const matches = glob('**/*.ts', ['z.ts', 'a.ts', 'b.txt', 'sub/m.ts']);
    expect(matches).toEqual(['a.ts', 'sub/m.ts', 'z.ts']);
  });

  it('canonicalizePath returns a canonical absolute path', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cas-skeleton-'));
    const canon = canonicalizePath(tmp);
    expect(path.isAbsolute(canon)).toBe(true);
    expect(canon.endsWith('/')).toBe(false);
  });

  it('stableStringify emits sorted keys with two-space indent and trailing newline', () => {
    const out = stableStringify({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(['a', 'b', 'nested']);
    expect(Object.keys(parsed.nested)).toEqual(['x', 'y']);

    const lines = out.split('\n');
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('localeSort uses variant-sensitivity, non-numeric ordering', () => {
    const sorted = localeSort(['file10', 'file2', 'file1']);

    expect(sorted).toEqual(['file1', 'file10', 'file2']);
  });
});

describe('logger', () => {
  it('logs to stderr when GAN_RUN_ID is unset', () => {
    const logger = getLogger({ forceStderr: true });
    expect(logger.sink()).toBe('stderr');
  });

  it('routes to <projectRoot>/.gan-state/runs/<id>/logs/config-server.log when GAN_RUN_ID is set', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cas-logger-'));
    const logger = getLogger({ projectRoot: tmp, runId: 'test-run' });
    const expected = path.join(tmp, '.gan-state', 'runs', 'test-run', 'logs', 'config-server.log');
    expect(logger.sink()).toBe(expected);
    logger.info('hello', { tool: 'getApiVersion', code: 'OK' });
    expect(existsSync(expected)).toBe(true);
    const contents = readFileSync(expected, 'utf8');
    expect(contents).toContain('"msg": "hello"');
    expect(contents).toContain('"tool": "getApiVersion"');

    const idxCode = contents.indexOf('"code"');
    const idxLevel = contents.indexOf('"level"');
    const idxMsg = contents.indexOf('"msg"');
    const idxTool = contents.indexOf('"tool"');
    const idxTs = contents.indexOf('"ts"');
    expect(idxCode).toBeGreaterThanOrEqual(0);
    expect(idxCode).toBeLessThan(idxLevel);
    expect(idxLevel).toBeLessThan(idxMsg);
    expect(idxMsg).toBeLessThan(idxTool);
    expect(idxTool).toBeLessThan(idxTs);
  });

  it('drops anonymisation-forbidden meta keys', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cas-logger-anon-'));
    const logger = getLogger({ projectRoot: tmp, runId: 'anon-run' });
    logger.info('redact-test', {
      tool: 'getStack',
      value: 'should-not-appear',
      trustHash: 'should-not-appear',
    });
    const expected = path.join(tmp, '.gan-state', 'runs', 'anon-run', 'logs', 'config-server.log');
    const contents = readFileSync(expected, 'utf8');
    expect(contents).not.toContain('should-not-appear');
    expect(contents).not.toContain('"value"');
    expect(contents).not.toContain('"trustHash"');
  });
});

describe('schemas-bundled', () => {
  it('loads all three JSON schemas with $id set', () => {
    expect(stackV1.$id).toContain('stack-v1.json');
    expect(overlayV1.$id).toContain('overlay-v1.json');
    expect(apiToolsV1.$id).toContain('api-tools-v1.json');
  });

  it('api-tools schema has additionalProperties: false at the top level', () => {
    expect(apiToolsV1.additionalProperties).toBe(false);
  });

  it('api-tools schema enumerates every F2 tool name', () => {
    const props = (apiToolsV1.properties ?? {}) as Record<string, unknown>;
    for (const name of F2_TOOL_NAMES) {
      expect(props[name]).toBeTruthy();
    }
  });
});

describe('buildToolList', () => {
  it('omits the NotImplemented stubs (F5 slice 1 filter)', () => {

    const names = buildToolList().map((t) => t.name);
    expect(names).not.toContain('getOverlayField');
    expect(names).not.toContain('getStackConventions');
  });

  it('every advertised tool is in the dispatcher-known set', () => {
    // Previously this asserted F2_TOOL_NAMES exclusively; the dispatcher now
    // unions F2 with R5 (trustList) and the run-context tool group, and the
    // advertised list expanded with it. The dispatch set is the broader
    // invariant — every advertised name must be one the dispatcher will
    // accept; F2 alone would re-introduce the dispatchable-but-undiscoverable
    // gap the union closed.
    const advertised = new Set(buildToolList().map((t) => t.name));
    for (const name of advertised) {
      expect(
        DISPATCH_TOOL_NAMES,
        `tool '${name}' is not in DISPATCH_TOOL_NAMES`,
      ).toContain(name);
    }
  });

  it('every entry has both inputSchema and the runtime required list', () => {
    for (const tool of buildToolList()) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(Array.isArray(tool.required)).toBe(true);
    }
  });
});

describe('boundary helper: requireRepoKey', () => {
  // C-1/I-003 fix: a free-form string passed verbatim into
  // `path.join(storeRoot, repoKey, 'run.lock')` would let `..` traversal
  // escape the store root and write/delete a lock file at an attacker-chosen
  // path. The helper now refutes any value that does not match
  // `REPO_KEY_PATTERN` (`<basename>-<12 hex>`).
  const TOOL = 'acquireRunLock';

  it('accepts a canonical computeRepoKey-shaped value', () => {
    const ok = requireRepoKey({ repoKey: 'my-repo-deadbeef0000' }, TOOL);
    expect(ok).toBe('my-repo-deadbeef0000');
  });

  it('rejects `..` traversal', () => {
    expect(() => requireRepoKey({ repoKey: '../../../tmp/foo' }, TOOL)).toThrow(
      ConfigServerError,
    );
  });

  it('rejects a forward-slash separator', () => {
    expect(() => requireRepoKey({ repoKey: 'tmp/foo-deadbeef0000' }, TOOL)).toThrow(
      ConfigServerError,
    );
  });

  it('rejects a backslash separator', () => {
    expect(() => requireRepoKey({ repoKey: 'tmp\\foo-deadbeef0000' }, TOOL)).toThrow(
      ConfigServerError,
    );
  });

  it('rejects an embedded NUL byte', () => {
    expect(() => requireRepoKey({ repoKey: 'my-repo-deadbeef0000\0junk' }, TOOL)).toThrow(
      ConfigServerError,
    );
  });

  it('rejects a missing hex tail', () => {
    expect(() => requireRepoKey({ repoKey: 'my-repo' }, TOOL)).toThrow(ConfigServerError);
  });

  it('rejects a non-hex tail', () => {
    expect(() => requireRepoKey({ repoKey: 'my-repo-zzzzzzzzzzzz' }, TOOL)).toThrow(
      ConfigServerError,
    );
  });

  it('still rejects empty/missing values (legacy guard)', () => {
    expect(() => requireRepoKey({ repoKey: '' }, TOOL)).toThrow(ConfigServerError);
    expect(() => requireRepoKey({}, TOOL)).toThrow(ConfigServerError);
  });

  it('surfaces MalformedInput as the error code', () => {
    try {
      requireRepoKey({ repoKey: '../escape' }, TOOL);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('MalformedInput');
    }
  });
});

describe('boundary helper: requireRunDir', () => {
  // C-1/I-004 fix: a free-form runDir would let trace tools create arbitrary
  // directories anywhere the server uid can write, scan unrelated dirs via
  // the summary readers, and inject `..` into `reconcileTraceIndex`'s
  // `path.basename(runDir)` deriving runId. The helper now decomposes
  // against `<storeRoot>/<repoKey>/runs/<runId>` with both regexes.
  const TOOL = 'emitTraceEvent';
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = mkdtempSync(path.join(tmpdir(), 'cas-rundir-'));
    vi.stubEnv('GAN_RUNS_DATA', storeRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a canonical resolveRunStore-shaped runDir', () => {
    const root = resolveStoreRoot();
    const runDir = path.join(root, 'my-repo-deadbeef0000', 'runs', '20260522T180000-0a01');
    expect(requireRunDir({ runDir }, TOOL)).toBe(runDir);
  });

  it('rejects a relative path', () => {
    expect(() =>
      requireRunDir({ runDir: 'my-repo-deadbeef0000/runs/20260522T180000-0a01' }, TOOL),
    ).toThrow(ConfigServerError);
  });

  it('rejects a path containing a `..` segment', () => {
    const root = resolveStoreRoot();
    const bad = path.join(root, 'my-repo-deadbeef0000', 'runs', '..', '20260522T180000-0a01');
    expect(() => requireRunDir({ runDir: bad }, TOOL)).toThrow(ConfigServerError);
  });

  it('rejects a path outside the resolved store root', () => {
    const outside = path.join(tmpdir(), 'unrelated', 'my-repo-deadbeef0000', 'runs', '20260522T180000-0a01');
    expect(() => requireRunDir({ runDir: outside }, TOOL)).toThrow(ConfigServerError);
  });

  it('rejects when the repoKey component does not match REPO_KEY_PATTERN', () => {
    const root = resolveStoreRoot();
    const bad = path.join(root, 'not-a-valid-key', 'runs', '20260522T180000-0a01');
    expect(() => requireRunDir({ runDir: bad }, TOOL)).toThrow(ConfigServerError);
  });

  it('rejects when the runId component does not match RUN_ID_PATTERN', () => {
    const root = resolveStoreRoot();
    const bad = path.join(root, 'my-repo-deadbeef0000', 'runs', 'not-a-valid-runid');
    expect(() => requireRunDir({ runDir: bad }, TOOL)).toThrow(ConfigServerError);
  });

  it('rejects when the middle segment is not literally `runs`', () => {
    const root = resolveStoreRoot();
    const bad = path.join(root, 'my-repo-deadbeef0000', 'sneak', '20260522T180000-0a01');
    expect(() => requireRunDir({ runDir: bad }, TOOL)).toThrow(ConfigServerError);
  });

  it('rejects an embedded NUL byte', () => {
    const root = resolveStoreRoot();
    const bad =
      path.join(root, 'my-repo-deadbeef0000', 'runs', '20260522T180000-0a01') + '\0junk';
    expect(() => requireRunDir({ runDir: bad }, TOOL)).toThrow(ConfigServerError);
  });

  it('still rejects empty/missing values (legacy guard)', () => {
    expect(() => requireRunDir({ runDir: '' }, TOOL)).toThrow(ConfigServerError);
    expect(() => requireRunDir({}, TOOL)).toThrow(ConfigServerError);
  });

  it('surfaces MalformedInput as the error code', () => {
    try {
      requireRunDir({ runDir: '/etc' }, TOOL);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('MalformedInput');
    }
  });
});

describe('api-tools-v1 schema: R7 wire-boundary patterns (defence in depth)', () => {
  // The dispatcher helpers refuse traversal at runtime; the schema mirrors
  // the same constraint so a malformed input is rejected before the
  // handler runs, per F5 § Parameter-shape consistency and the C-1/I-006
  // "two homes for one fact, both must agree" rule.
  const props = (apiToolsV1.properties ?? {}) as Record<
    string,
    {
      inputSchema?: {
        properties?: Record<string, { pattern?: string }>;
        required?: string[];
        minProperties?: number;
      };
    }
  >;

  it('acquireRunLock pins a pattern on `repoKey` (REPO_KEY_PATTERN)', () => {
    expect(props['acquireRunLock']?.inputSchema?.properties?.['repoKey']?.pattern).toBe(
      '^[A-Za-z0-9._-]+-[0-9a-f]{12}$',
    );
  });

  it('releaseRunLock pins a pattern on `repoKey` AND requires `runId`', () => {
    expect(props['releaseRunLock']?.inputSchema?.properties?.['repoKey']?.pattern).toBe(
      '^[A-Za-z0-9._-]+-[0-9a-f]{12}$',
    );
    expect(props['releaseRunLock']?.inputSchema?.required ?? []).toEqual(
      expect.arrayContaining(['repoKey', 'runId']),
    );
    expect(props['releaseRunLock']?.inputSchema?.properties?.['runId']?.pattern).toBe(
      '^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$',
    );
  });

  it.each([
    'emitTraceEvent',
    'runSprintSummary',
    'aggregateRunSummary',
    'reconcileTraceIndex',
    'reconstructRecoveryState',
  ])('%s pins a `runDir` pattern matching <storeRoot>/<repoKey>/runs/<runId>', (name) => {
    expect(props[name]?.inputSchema?.properties?.['runDir']?.pattern).toBe(
      '^.+/[A-Za-z0-9._-]+-[0-9a-f]{12}/runs/[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$',
    );
  });

  it('dockerDiscoverPort requires at least one discovery layer (minProperties:1)', () => {
    // Every layer is individually optional, but a structurally-empty `{}`
    // call must be rejected at the catalog boundary rather than throwing
    // PortNotDiscovered at runtime once every layer is exhausted.
    expect(props['dockerDiscoverPort']?.inputSchema?.minProperties).toBe(1);
  });

  it('dockerCheckContainerHealth catalog description telegraphs that it BLOCKS', () => {
    // The wire name ("Check") reads as a one-shot probe, but the tool polls
    // up to timeoutSeconds. The catalog description must say so, and it must
    // reach the advertised tool list an LLM caller reads.
    const desc = (
      apiToolsV1.properties as Record<string, { description?: string }>
    )?.['dockerCheckContainerHealth']?.description;
    expect(desc).toMatch(/BLOCKS|block/);
    expect(desc).toMatch(/timeoutSeconds/);

    const advertised = buildToolList().find((t) => t.name === 'dockerCheckContainerHealth');
    expect(advertised?.description).toBe(desc);
  });
});

describe('MCP handshake (subprocess)', () => {
  it('responds to tools/list with every wired F2 tool name (F5 slice 1)', async () => {
    const distEntry = path.join(repoRoot, 'dist', 'config-server', 'index.js');
    if (!existsSync(distEntry)) {

      return;
    }
    const child = spawn(process.execPath, [distEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test-client', version: '0.0.1' },
        capabilities: {},
      },
    };
    const listRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    child.stdin.write(JSON.stringify(initRequest) + '\n');
    child.stdin.write(JSON.stringify(listRequest) + '\n');

    const responses: unknown[] = [];
    let buffer = '';
    const allResponses = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            responses.push(parsed);
            const r = parsed as { id?: number };
            if (r.id === 2) {
              clearTimeout(timer);
              resolve();
            }
          } catch {
            // Non-JSON line; skip.
          }
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    await allResponses;
    child.stdin.end();
    child.kill();

    const listResp = responses.find(
      (r): r is { id: number; result: { tools: Array<{ name: string }> } } => {
        return typeof r === 'object' && r !== null && (r as { id?: number }).id === 2;
      },
    );
    expect(listResp).toBeTruthy();
    const names = listResp!.result.tools.map((t) => t.name);

    expect(names).not.toContain('getOverlayField');
    expect(names).not.toContain('getStackConventions');

    for (const name of names) {
      // The dispatcher unions F2 with R5 (trustList) and the run-context
      // tools introduced by the runtime invocation bridge; the F2-only
      // assertion would re-fail every additive tool group after R5. The
      // dispatch set is the broader invariant — every advertised name must
      // be one the dispatcher will accept.
      expect(
        DISPATCH_TOOL_NAMES,
        `tool '${name}' is not in DISPATCH_TOOL_NAMES`,
      ).toContain(name);
    }
  });
});
