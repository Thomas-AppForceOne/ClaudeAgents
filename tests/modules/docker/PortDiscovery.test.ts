/**
 * M2 — PortDiscovery tests.
 *
 * Covers AC7: one named test per layer + one for throw-on-exhaustion.
 *
 *   1. Env-var layer (`options.envVar` is a NAME, read from process.env).
 *   2. PortRegistry lookup for the current worktree.
 *   3. `docker ps --filter name=...` parsing.
 *   4. options.fallbackPort.
 *
 * The env-var test stubs `process.env` (via the `env` option) and
 * asserts unset, "not-a-number", "99999" all fall through.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPort } from '../../../src/modules/docker/PortDiscovery.js';
import {
  PortRegistry,
  createDefaultRegistryApi,
} from '../../../src/modules/docker/PortRegistry.js';

describe('PortDiscovery.discoverPort', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-discover-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('layer 1: env var name resolves via process.env to a port value', async () => {
    const port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: { TEST_DOCKER_PORT: '9090' },
    });
    expect(port).toBe(9090);
  });

  it('layer 1 fall-through: unset, non-numeric, and out-of-range env values fall to next layer', async () => {
    // Unset.
    let port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: {},
      fallbackPort: 1111,
    });
    expect(port).toBe(1111);

    // Non-numeric.
    port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: { TEST_DOCKER_PORT: 'not-a-number' },
      fallbackPort: 2222,
    });
    expect(port).toBe(2222);

    // Out of range.
    port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: { TEST_DOCKER_PORT: '99999' },
      fallbackPort: 3333,
    });
    expect(port).toBe(3333);
  });

  it('layer 2: PortRegistry lookup for the current worktree', async () => {
    const api = createDefaultRegistryApi(scratch);
    const reg = new PortRegistry(api);
    const wt = path.join(scratch, 'wt');
    mkdirSync(wt, { recursive: true });
    reg.register(wt, 7777, 'app-77');
    const port = await discoverPort({
      registry: reg,
      worktreePath: wt,
    });
    expect(port).toBe(7777);
  });

  it('layer 3: docker ps output parses the host port', async () => {
    const port = await discoverPort({
      containerPattern: 'myapp-*',
      dockerPsRunner: () => ({
        status: 0,
        stdout: '0.0.0.0:8081->80/tcp\n',
        stderr: '',
      }),
    });
    expect(port).toBe(8081);
  });

  it('layer 4: fallbackPort is returned when previous layers do not match', async () => {
    const port = await discoverPort({
      // No env var, no registry, no container pattern.
      fallbackPort: 4040,
    });
    expect(port).toBe(4040);
  });

  it('throws PortNotDiscovered when every layer is exhausted', async () => {
    let caught: unknown = null;
    try {
      await discoverPort({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('PortNotDiscovered');
  });

  it('source uses options.envVar as a key into process.env (not a literal port)', () => {
    // Sourcecode probe — the contract verifier asserts the value
    // is used as a key into process.env. We mirror that here.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..', '..');
    const src = readFileSync(
      path.join(repoRoot, 'src', 'modules', 'docker', 'PortDiscovery.ts'),
      'utf8',
    );
    expect(src).toMatch(/env\[options\.envVar\]/);
  });
});
