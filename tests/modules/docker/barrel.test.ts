/**
 * M2 barrel — prerequisite check fires at module-evaluation time.
 *
 * The barrel runs `docker --version` via `child_process.execFileSync`
 * before re-exporting any utility. We exercise both branches:
 *
 *   1. **Failure path.** `execFileSync` is mocked to throw; importing
 *      the barrel rejects with a `ConfigServerError` whose message
 *      includes the manifest's `errorHint`.
 *   2. **Success path.** `execFileSync` is mocked to return successfully;
 *      the barrel exposes all five manifest names.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:child_process');
});

describe('docker barrel prerequisite check', () => {
  it('throws with manifest errorHint when docker --version fails', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => {
        throw new Error('spawn docker ENOENT');
      },
    }));
    let caught: unknown = null;
    try {
      await import('../../../src/modules/docker/index.js');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught instanceof Error).toBe(true);
    expect(String((caught as Error).message)).toContain(
      'Install Docker Desktop or Docker Engine.',
    );
  });

  it('exposes all five manifest exports when docker --version succeeds', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => Buffer.from('Docker version 24.0.0, build abcdef\n'),
      spawnSync: () => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
    }));
    const mod = await import('../../../src/modules/docker/index.js');
    expect(mod.PortRegistry).toBeDefined();
    expect(mod.ContainerNaming).toBeDefined();
    expect(mod.PortValidator).toBeDefined();
    expect(mod.PortDiscovery).toBeDefined();
    expect(mod.ContainerHealth).toBeDefined();
  });
});
