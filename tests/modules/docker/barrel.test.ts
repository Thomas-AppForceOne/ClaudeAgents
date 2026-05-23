// Contract for the docker module barrel (src/modules/docker/index.js). Importing the
// barrel runs the manifest's prerequisite check (`docker --version`) as a side effect
// of module load. The suite guards two halves of that gate: when the prerequisite
// process fails, the import must reject with the manifest's own errorHint surfaced in
// the message (so an actionable hint reaches the user); when it succeeds, the barrel
// must re-export exactly the five public classes the manifest declares. child_process
// is mocked per test so neither the real docker binary nor a real spawn is ever
// invoked, and modules are reset around each case so the load-time check re-runs.

import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  // The prerequisite check fires at import time, so the module cache must be cleared
  // and the child_process mock undone between tests to force a fresh, unmocked load.
  vi.resetModules();
  vi.doUnmock('node:child_process');
});

describe('docker barrel prerequisite check', () => {
  it('throws with manifest errorHint when docker --version fails', async () => {
    vi.resetModules();
    // Simulate docker not being installed: the prerequisite probe throws ENOENT,
    // which the loader must translate into a failure carrying the manifest's hint.
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
    // Simulate a healthy docker install: execFileSync returns a plausible version
    // banner so the prerequisite passes and the barrel finishes loading.
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
