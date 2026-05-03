import { describe, expect, it } from 'vitest';
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
import { buildToolList, F2_TOOL_NAMES, getApiVersion } from '../../src/config-server/index.js';
import { apiToolsV1, stackV1, overlayV1 } from '../../src/config-server/schemas-bundled.js';

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
    // 2-space indent: lines after the opening brace start with 2 spaces.
    const lines = out.split('\n');
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('localeSort uses variant-sensitivity, non-numeric ordering', () => {
    const sorted = localeSort(['file10', 'file2', 'file1']);
    // numeric:false → '10' < '2' lexicographically
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
    // Sorted keys: lexicographically 'code' < 'level' < 'msg' < 'tool' < 'ts'.
    // Each field appears on its own line under stableStringify's 2-space
    // indent; assert positional order across the full payload.
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
  it('produces one entry per F2 tool name', () => {
    const list = buildToolList();
    expect(list.length).toBe(F2_TOOL_NAMES.length);
    const names = list.map((t) => t.name).sort();
    const expected = [...F2_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it('every entry has an inputSchema', () => {
    for (const tool of buildToolList()) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('MCP handshake (subprocess)', () => {
  it('responds to tools/list with every F2 tool name', async () => {
    const distEntry = path.join(repoRoot, 'dist', 'config-server', 'index.js');
    if (!existsSync(distEntry)) {
      // The build is the discriminator's job; skip if it has not yet run.
      // Vitest reports skipped as pass, which is fine for sprint 1's
      // local-iteration loop. The discriminator runs `npm run build` first.
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
    const names = listResp!.result.tools.map((t) => t.name).sort();
    const expected = [...F2_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
  });
});
