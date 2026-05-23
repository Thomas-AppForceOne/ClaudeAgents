
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { F2_TOOL_NAMES } from '../../../src/config-server/index.js';
import { initGitRepo, useTempModuleStateStore } from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const distEntry = path.join(repoRoot, 'dist', 'config-server', 'index.js');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const tmpDirs: string[] = [];
const liveChildren: ChildProcessWithoutNullStreams[] = [];
const envRestores: Array<() => void> = [];

afterEach(() => {
  for (const restore of envRestores.splice(0)) restore();
  for (const c of liveChildren.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingDispatcher {
  send(payload: Record<string, unknown>): void;
  awaitId(id: number, timeoutMs?: number): Promise<JsonRpcResponse>;
}

function dispatcherFor(child: ChildProcessWithoutNullStreams): PendingDispatcher {
  const waiters = new Map<number, (r: JsonRpcResponse) => void>();
  const buffered: JsonRpcResponse[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse;
        const rid = typeof parsed.id === 'number' ? parsed.id : null;
        if (rid !== null && waiters.has(rid)) {
          waiters.get(rid)!(parsed);
          waiters.delete(rid);
        } else {
          buffered.push(parsed);
        }
      } catch {
        // skip non-JSON lines
      }
    }
  });

  return {
    send(payload) {
      child.stdin.write(JSON.stringify(payload) + '\n');
    },
    awaitId(id, timeoutMs = 10_000) {

      const buffered_match = buffered.findIndex((r) => r.id === id);
      if (buffered_match >= 0) {
        const r = buffered.splice(buffered_match, 1)[0];
        return Promise.resolve(r);
      }
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`timeout awaiting id=${id}`));
        }, timeoutMs);
        waiters.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
    },
  };
}

describe('integration: MCP handshake (subprocess)', () => {
  it('handles initialize → tools/list → tool calls and exits cleanly on stdin close', async () => {
    if (!existsSync(distEntry)) {
      throw new Error(`Build artefact not found at ${distEntry}; run npm run build first.`);
    }

    const projectRoot = mkdtempSync(path.join(tmpdir(), 'cas-mcp-'));
    cpSync(jsTsMinimal, projectRoot, { recursive: true });
    tmpDirs.push(projectRoot);

    initGitRepo(projectRoot);
    const moduleStore = useTempModuleStateStore();
    tmpDirs.push(moduleStore.storeRoot);
    envRestores.push(moduleStore.restore);

    const stagedPkgRoot = mkdtempSync(path.join(tmpdir(), 'cas-mcp-pkgroot-'));
    tmpDirs.push(stagedPkgRoot);
    writeFileSync(
      path.join(stagedPkgRoot, 'package.json'),
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    const dockerDir = path.join(stagedPkgRoot, 'src', 'modules', 'docker');
    mkdirSync(dockerDir, { recursive: true });
    writeFileSync(
      path.join(dockerDir, 'manifest.json'),
      JSON.stringify(
        {
          name: 'docker',
          schemaVersion: 1,
          description: 'Container and port management for git worktree workflows.',
          exports: ['PortRegistry'],
          stateKeys: ['port-registry'],
        },
        null,
        2,
      ),
    );

    const runId = 'mcp-handshake-test';
    const child = spawn(process.execPath, [distEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GAN_RUN_ID: runId,
        GAN_PACKAGE_ROOT_OVERRIDE: stagedPkgRoot,
        GAN_MODULE_STATE: moduleStore.storeRoot,
      },
      cwd: projectRoot,
    });
    liveChildren.push(child);

    const stderrChunks: string[] = [];
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString('utf8')));

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      },
    );

    const rpc = dispatcherFor(child);

    rpc.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'mcp-handshake-test', version: '0.0.1' },
        capabilities: {},
      },
    });
    const init = await rpc.awaitId(1);
    expect(init.error).toBeUndefined();

    rpc.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const list = (await rpc.awaitId(2)) as JsonRpcResponse & {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    const names = list.result.tools.map((t) => t.name);
    expect(names).not.toContain('getOverlayField');
    expect(names).not.toContain('getStackConventions');
    for (const name of names) {
      expect(F2_TOOL_NAMES, `tool '${name}' is not in F2_TOOL_NAMES`).toContain(name);
    }

    rpc.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'getResolvedConfig',
        arguments: { projectRoot },
      },
    });
    const readResp = (await rpc.awaitId(3)) as JsonRpcResponse & {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(readResp.error).toBeUndefined();
    expect(readResp.result.isError).toBeFalsy();
    const readPayload = JSON.parse(readResp.result.content[0].text) as Record<string, unknown>;
    expect(readPayload.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(readPayload.schemaVersions).toEqual({ stack: 1, overlay: 1 });

    rpc.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'setOverlayField',
        arguments: {
          projectRoot,
          tier: 'project',
          fieldPath: 'planner.additionalContext',
          value: ['docs/notes.md'],
        },
      },
    });
    const writeResp = (await rpc.awaitId(4)) as JsonRpcResponse & {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(writeResp.result.isError).toBeFalsy();
    const writePayload = JSON.parse(writeResp.result.content[0].text) as Record<string, unknown>;
    expect(writePayload.mutated).toBe(true);
    expect(typeof writePayload.path).toBe('string');

    const moduleStateBlob = {
      ports: [3000, 3001],
      settings: { healthy: true, label: 'mcp-handshake-module-state' },
      count: 2,
    };
    rpc.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'setModuleState',
        arguments: {
          projectRoot,
          name: 'docker',
          key: 'port-registry',
          state: moduleStateBlob,
        },
      },
    });
    const setStateResp = (await rpc.awaitId(5)) as JsonRpcResponse & {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(setStateResp.error).toBeUndefined();
    expect(setStateResp.result.isError).toBeFalsy();
    const setStatePayload = JSON.parse(setStateResp.result.content[0].text) as Record<
      string,
      unknown
    >;
    expect(setStatePayload.mutated).toBe(true);
    expect(typeof setStatePayload.path).toBe('string');

    expect(setStatePayload.path as string).toBe(
      moduleStore.statePath(projectRoot, 'docker', 'port-registry'),
    );
    expect(
      (setStatePayload.path as string).endsWith(path.join('docker', 'port-registry.json')),
    ).toBe(true);
    expect(setStatePayload.path as string).not.toContain(path.join('.gan-state', 'modules'));

    rpc.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'getModuleState',
        arguments: {
          projectRoot,
          name: 'docker',
          key: 'port-registry',
        },
      },
    });
    const getStateResp = (await rpc.awaitId(6)) as JsonRpcResponse & {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(getStateResp.error).toBeUndefined();
    expect(getStateResp.result.isError).toBeFalsy();
    const getStatePayload = JSON.parse(getStateResp.result.content[0].text) as Record<
      string,
      unknown
    >;
    expect(getStatePayload.state).toEqual(moduleStateBlob);

    expect((getStatePayload.state as { settings: { label: string } }).settings.label).toBe(
      'mcp-handshake-module-state',
    );

    rpc.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'setModuleState',
        arguments: { projectRoot, state: { anything: true } },
      },
    });
    const errorResp = (await rpc.awaitId(7)) as JsonRpcResponse & {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(errorResp.error).toBeUndefined();
    expect(errorResp.result.isError).toBe(true);
    expect(Array.isArray(errorResp.result.content)).toBe(true);
    const errorPayload = JSON.parse(errorResp.result.content[0].text) as Record<string, unknown>;
    expect(typeof errorPayload.code).toBe('string');
    expect(errorPayload.code).toBe('MalformedInput');
    expect(typeof errorPayload.message).toBe('string');

    rpc.send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'setModuleState',
        arguments: {
          projectRoot,
          name: 'docker',
          key: 'made-up-key',
          state: { anything: true },
        },
      },
    });
    const unknownKeyResp = (await rpc.awaitId(8)) as JsonRpcResponse & {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(unknownKeyResp.error).toBeUndefined();
    expect(unknownKeyResp.result.isError).toBe(true);
    expect(Array.isArray(unknownKeyResp.result.content)).toBe(true);
    const unknownKeyPayload = JSON.parse(unknownKeyResp.result.content[0].text) as Record<
      string,
      unknown
    >;
    expect(unknownKeyPayload.code).toBe('UnknownStateKey');
    expect(typeof unknownKeyPayload.message).toBe('string');
    expect(unknownKeyPayload.message as string).toContain('docker');
    expect(unknownKeyPayload.message as string).toContain('made-up-key');

    const expectedLogPath = path.join(
      projectRoot,
      '.gan-state',
      'runs',
      runId,
      'logs',
      'config-server.log',
    );
    expect(existsSync(expectedLogPath)).toBe(true);
    const logText = readFileSync(expectedLogPath, 'utf8');

    expect(logText).toContain('"tool": "getResolvedConfig"');
    expect(logText).toContain('"tool": "setOverlayField"');

    expect(logText).not.toContain('docs/notes.md');
    expect(logText).not.toContain('"value"');
    expect(logText).not.toContain('"trustHash"');
    expect(logText).not.toContain('mcp-handshake-module-state');

    expect(logText).not.toContain('made-up-key');

    child.stdin.end();
    const exitInfo = await Promise.race([
      exitPromise,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        setTimeout(() => resolve({ code: -1, signal: 'TIMEOUT' as NodeJS.Signals }), 5_000),
      ),
    ]);
    if (exitInfo.signal === ('TIMEOUT' as NodeJS.Signals)) {

      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      throw new Error(
        `subprocess did not exit within 5s of stdin close; stderr: ${stderrChunks.join('')}`,
      );
    }
    expect(exitInfo.code === 0 || exitInfo.signal !== null).toBe(true);
  }, 30_000);
});
