

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPort } from '../../../src/modules/docker/PortDiscovery.js';
import { PortRegistry } from '../../../src/modules/docker/PortRegistry.js';
import { _resetModuleRegistrationCacheForTests } from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';
import {
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function stageDockerModuleRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'm2-disc-modroot-'));
  writeFileSync(
    path.join(root, 'package.json'),
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const dir = path.join(root, 'src', 'modules', 'docker');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'manifest.json'),
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
  return root;
}

describe('PortDiscovery.discoverPort', () => {
  let scratch: string;
  let stagedRoot: string;
  let savedOverride: string | undefined;
  let store: ModuleStateStoreScope;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-discover-'));

    initGitRepo(scratch);
    store = useTempModuleStateStore();
    savedOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    stagedRoot = stageDockerModuleRoot();
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = stagedRoot;
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });
  afterEach(() => {
    store.restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(stagedRoot, { recursive: true, force: true });
    rmSync(store.storeRoot, { recursive: true, force: true });
    if (savedOverride === undefined) {
      delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    } else {
      process.env.GAN_PACKAGE_ROOT_OVERRIDE = savedOverride;
    }
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });

  it('layer 1: env var name resolves via process.env to a port value', async () => {
    const port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: { TEST_DOCKER_PORT: '9090' },
    });
    expect(port).toBe(9090);
  });

  it('layer 1 fall-through: unset, non-numeric, and out-of-range env values fall to next layer', async () => {

    let port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: {},
      fallbackPort: 1111,
    });
    expect(port).toBe(1111);

    port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: { TEST_DOCKER_PORT: 'not-a-number' },
      fallbackPort: 2222,
    });
    expect(port).toBe(2222);

    port = await discoverPort({
      envVar: 'TEST_DOCKER_PORT',
      env: { TEST_DOCKER_PORT: '99999' },
      fallbackPort: 3333,
    });
    expect(port).toBe(3333);
  });

  it('layer 2: PortRegistry lookup for the current worktree', async () => {
    const reg = new PortRegistry(scratch);
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

    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..', '..');
    const src = readFileSync(
      path.join(repoRoot, 'src', 'modules', 'docker', 'PortDiscovery.ts'),
      'utf8',
    );
    expect(src).toMatch(/env\[options\.envVar\]/);
  });
});
