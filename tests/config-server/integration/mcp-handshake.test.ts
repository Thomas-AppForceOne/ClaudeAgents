/**
 * R1 sprint 7 integration test — full MCP handshake against the built
 * server binary.
 *
 *   1. Spawn `node ./dist/config-server/index.js` as a subprocess with
 *      `GAN_RUN_ID` set so logs route to the per-run log file under the
 *      project root.
 *   2. Send `initialize` (MCP), then `tools/list`. Assert every F2 tool
 *      name appears in the response.
 *   3. Call a representative read tool (`getResolvedConfig` against the
 *      `js-ts-minimal` fixture) and a representative write tool
 *      (`setOverlayField` against a temp-dir copy of the same fixture).
 *      Both must succeed with structured payloads. Then exercise the
 *      M1 module-state surface end-to-end via `setModuleState` followed
 *      by `getModuleState`, asserting the persisted blob round-trips
 *      verbatim through the MCP transport.
 *   4. Assert the per-run log file exists with at least one entry per
 *      tool call, and that overlay values, module-state values, and
 *      trust hashes never appear in the log (anonymisation contract).
 *   5. Close stdin and verify the subprocess exits cleanly within the
 *      timeout window.
 */
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const distEntry = path.join(repoRoot, 'dist', 'config-server', 'index.js');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const tmpDirs: string[] = [];
const liveChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
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

/**
 * Wire a JSON-RPC dispatcher around a child process's stdio. Lines on
 * stdout are parsed as JSON-RPC responses; awaiters keyed by request id
 * resolve when their matching response arrives.
 */
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
      // Drain buffered responses for late-bound waiters.
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

    // Build a temp project so writes don't pollute the committed fixture.
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'cas-mcp-'));
    cpSync(jsTsMinimal, projectRoot, { recursive: true });
    tmpDirs.push(projectRoot);

    // Stage a fake package root containing a `docker` module manifest
    // declaring `port-registry` as an allowed state key, so the M3
    // allowlist gate finds the key when the subprocess processes
    // `setModuleState` / `getModuleState` calls. Without this override
    // the global vitest setup's empty fake root would leave the docker
    // module unregistered and every write would reject with
    // `UnknownStateKey`.
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

    // 1. initialize
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

    // 2. tools/list — assert every F2 tool name present.
    rpc.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const list = (await rpc.awaitId(2)) as JsonRpcResponse & {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    const names = list.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...F2_TOOL_NAMES].sort());

    // 3a. Representative read tool: getResolvedConfig.
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

    // 3b. Representative write tool: setOverlayField against the temp fixture.
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

    // 3c. Module-state write: setModuleState round-trips the blob to disk.
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
    expect(
      (setStatePayload.path as string).endsWith(
        path.join('.gan-state', 'modules', 'docker', 'port-registry.json'),
      ),
    ).toBe(true);

    // 3d. Module-state read: getModuleState returns the same blob verbatim.
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
    // Sanity-check the round-trip carried the labelled marker through.
    expect(
      ((getStatePayload.state as { settings: { label: string } }).settings.label),
    ).toBe('mcp-handshake-module-state');

    // 3c. Error-path round-trip: malformed input (missing `name`) on a
    // module-state tool must surface a structured error through the MCP
    // envelope (isError: true + JSON-encoded ConfigServerError payload).
    // Locks in the failure-shape contract for any caller relying on
    // isError to detect tool failures over JSON-RPC.
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

    // 3e. Module-state allowlist round-trip: a setModuleState call with
    // an undeclared `key` must reject with a structured `UnknownStateKey`
    // error over the MCP envelope. The manifest staged above declares
    // only `port-registry`; `made-up-key` is therefore outside the
    // allowlist. The error message must name both the module and the
    // offending key (per the M3 spec). The made-up key string must not
    // leak into the per-run log (anonymisation contract: state-key
    // strings are caller-supplied identifiers and the dispatcher echoes
    // only the anonymised arg shape).
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
    const unknownKeyPayload = JSON.parse(
      unknownKeyResp.result.content[0].text,
    ) as Record<string, unknown>;
    expect(unknownKeyPayload.code).toBe('UnknownStateKey');
    expect(typeof unknownKeyPayload.message).toBe('string');
    expect(unknownKeyPayload.message as string).toContain('docker');
    expect(unknownKeyPayload.message as string).toContain('made-up-key');

    // 4. Per-run log file present and well-formed.
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
    // Every dispatched tool emitted at least one log line referencing it.
    expect(logText).toContain('"tool": "getResolvedConfig"');
    expect(logText).toContain('"tool": "setOverlayField"');
    // Anonymisation contract: the overlay value we sent must never
    // appear verbatim in the log (the dispatcher echoes only the
    // anonymised arg shape).
    expect(logText).not.toContain('docs/notes.md');
    expect(logText).not.toContain('"value"'); // forbidden meta key
    expect(logText).not.toContain('"trustHash"');
    expect(logText).not.toContain('mcp-handshake-module-state');
    // The undeclared state-key string passed in id-8 is caller-supplied
    // identifier surface. The anonymiser redacts `key` to a presence
    // flag, so the literal 'made-up-key' must never appear in the log.
    expect(logText).not.toContain('made-up-key');

    // 5. Close stdin → subprocess exits cleanly.
    child.stdin.end();
    const exitInfo = await Promise.race([
      exitPromise,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        setTimeout(() => resolve({ code: -1, signal: 'TIMEOUT' as NodeJS.Signals }), 5_000),
      ),
    ]);
    if (exitInfo.signal === ('TIMEOUT' as NodeJS.Signals)) {
      // Failsafe: kill the child so the test cleanup doesn't leak. Then
      // surface a clear failure.
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
