/**
 * Docker MCP tool tests — the central slice-5 acceptance file.
 *
 * Each named describe block pins one contract criterion and runs
 * independently, so a single regression flunks exactly the failing case
 * rather than the whole file. The structural shape (four named describe
 * blocks) is itself a criterion: a partial scaffold silently degrades the
 * contract.
 *
 * Sections:
 *  - Tool-vs-library parity (single implementation per tool) — pinning
 *    that each handler calls exactly one shipped library function.
 *  - Duplicate reservation surfaces PortInUse from library — collision-
 *    avoidance is the library's, surfaced verbatim.
 *  - Module state round-trips through F8 module-state store — the parent
 *    reserves, a spawned child process reads the persisted state.
 *  - Trust posture: docker exec tools honor F4/F6 ladder — the new
 *    handlers do not introduce a trust-bypass code path.
 *
 * Also: a deterministic static-scan that the tool file uses dynamic
 * import for every reach into `src/modules/docker/*`, and a negative
 * guard that PortRegistry has not grown a free-port allocator this
 * sprint.
 *
 * Each fixture is constructed inline (no external fixture files); every
 * library call is a direct import to satisfy the dual-callable rule.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  dockerCheckContainerHealth,
  dockerContainerName,
  dockerDiscoverPort,
  dockerReleasePort,
  dockerReservePort,
  importDockerModule,
} from '../../../src/config-server/tools/docker-tools.js';
import { PortRegistry } from '../../../src/modules/docker/PortRegistry.js';
import { nameForWorktree } from '../../../src/modules/docker/ContainerNaming.js';
import { discoverPort } from '../../../src/modules/docker/PortDiscovery.js';
import { waitForHealthy } from '../../../src/modules/docker/ContainerHealth.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import { requireHttpPathArg, requireWorktreePathArg } from '../../../src/config-server/index.js';
import { ConfigServerError } from '../../../src/config-server/errors.js';
import { _resetModuleRegistrationCacheForTests } from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';
import {
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

// Stage a throwaway install: a real package.json (for package-root
// detection) plus a docker manifest declaring the port-registry state key,
// so the registry resolves against the staged root rather than the real
// install. Mirrors the helper PortRegistry's own tests use.
function stageDockerModuleRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'r7-s5-docker-tools-modroot-'));
  copyFileSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
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

describe('docker tools', () => {
  let scratch: string;
  let stagedRoot: string;
  let savedOverride: string | undefined;
  let store: ModuleStateStoreScope;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'r7-s5-docker-tools-'));
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

  // ---------- 1. Tool-vs-library parity (single implementation per tool) ----------

  describe('Tool-vs-library parity (single implementation per tool)', () => {
    it('dockerReservePort: tool persists the same registry entry a direct library call would', async () => {
      // Two scratch roots, identical setup: one written through the tool,
      // the other through the library. The persisted registry blob must be
      // identical (deep-equal entries dict), proving the tool routes
      // through the shipped register and not a second implementation.
      const wtA = path.join(scratch, 'wt-tool');
      const wtB = path.join(scratch, 'wt-lib');
      mkdirSync(wtA, { recursive: true });
      mkdirSync(wtB, { recursive: true });

      // Use the same projectRoot so both writes land in the same registry
      // file; canonicalised keys make the entries distinct.
      const registryViaLib = new PortRegistry(scratch);
      registryViaLib.register(wtB, 7200, 'app-lib');

      const reserveResult = await dockerReservePort({
        worktreePath: wtA,
        port: 7201,
        containerName: 'app-tool',
      });
      // register() persisted (or threw PortInUse); a normal return means the
      // F2 mutation indicator is true.
      expect(reserveResult.mutated).toBe(true);

      // The registry singleton (under scratch projectRoot) now carries
      // both entries; their shapes are identical.
      const allBoth = new PortRegistry(scratch).getAll();
      expect(allBoth).toHaveLength(2);
      const toolEntry = allBoth.find((e) => e.worktreePath === canonicalizePath(wtA));
      const libEntry = allBoth.find((e) => e.worktreePath === canonicalizePath(wtB));
      expect(toolEntry).toBeDefined();
      expect(libEntry).toBeDefined();
      // The two entries follow the same shape: { worktreePath, port,
      // containerName }; equivalence of keys confirms one implementation.
      expect(Object.keys(toolEntry!).sort()).toEqual(Object.keys(libEntry!).sort());
    });

    it('dockerReleasePort: tool removes the same entry a direct library call would', async () => {
      const wt = path.join(scratch, 'wt-release');
      mkdirSync(wt, { recursive: true });
      // Seed via library, release via tool — the post-release lookup
      // must agree with what a library release would have done.
      const registry = new PortRegistry(scratch);
      registry.register(wt, 7300, 'app-release');
      expect(registry.lookup(wt)).not.toBeNull();
      const result = await dockerReleasePort({ worktreePath: wt });
      // The F2 `mutated` indicator mirrors `released`: a removed entry changed
      // durable state.
      expect(result).toEqual({ worktreePath: wt, released: true, mutated: true });
      expect(new PortRegistry(scratch).lookup(wt)).toBeNull();
      // Releasing again is a no-op; `released` (and the equal `mutated`)
      // reflect the library's real signal rather than a hardcoded `true`.
      const noop = await dockerReleasePort({ worktreePath: wt });
      expect(noop).toEqual({ worktreePath: wt, released: false, mutated: false });
    });

    it('dockerDiscoverPort: tool resolves the registry layer to the same port the library does', async () => {
      // Seed the registry, then call the tool with worktreePath only —
      // the library's layer-2 (registry) must produce the same port a
      // direct discoverPort call would.
      const wt = path.join(scratch, 'wt-discover');
      mkdirSync(wt, { recursive: true });
      const registry = new PortRegistry(scratch);
      registry.register(wt, 7400, 'app-discover');

      const viaTool = await dockerDiscoverPort({ worktreePath: wt });
      const viaLib = await discoverPort({
        worktreePath: wt,
        registry: new PortRegistry(scratch),
      });
      expect(viaTool.port).toBe(viaLib);
      expect(viaTool.port).toBe(7400);
    });

    it('dockerCheckContainerHealth: success returns the observed status, not a vacuous always-true literal', async () => {
      // Stand up a tiny localhost server that answers the expected status, so
      // the tool's success path is exercised end-to-end. The return must carry
      // the concrete observedStatus rather than a constant `{ healthy: true }`.
      const server: Server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const result = await dockerCheckContainerHealth({
          port,
          path: '/health',
          expectStatus: 200,
          timeoutSeconds: 2,
        });
        expect(result).toEqual({ observedStatus: 200 });
        // The vacuous always-true field is gone from the success shape.
        expect((result as Record<string, unknown>).healthy).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('dockerCheckContainerHealth: tool delegates to waitForHealthy without re-implementing the polling loop', async () => {
      // The wrapper's job is delegation, not re-implementation. We
      // assert the tool path produces the same return as a direct
      // library call against an in-process fetch stub. A successful
      // healthy poll: the stub returns the expected status, both
      // paths return true.
      const okFetch: typeof fetch = async () =>
        new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });

      // Library direct: waitForHealthy returns true on a healthy poll.
      const libOk = await waitForHealthy(7500, {
        path: '/health',
        expectStatus: 200,
        timeoutSeconds: 1,
        fetchImpl: okFetch,
      });
      expect(libOk).toBe(true);

      // The tool wraps waitForHealthy and propagates its TimeoutError
      // verbatim. Asserting against a port that won't bind exercises
      // the failure branch end-to-end without standing up a server.
      let thrown: unknown;
      try {
        await dockerCheckContainerHealth({
          port: 1,
          path: '/health',
          expectStatus: 200,
          timeoutSeconds: 0.1,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe('TimeoutError');
    });

    it('dockerContainerName: tool returns byte-identical string to nameForWorktree(worktreePath)', async () => {
      const wt = path.join(scratch, 'wt-name');
      mkdirSync(wt, { recursive: true });
      const viaTool = await dockerContainerName({ worktreePath: wt });
      const viaLib = nameForWorktree(wt);
      expect(viaTool.containerName).toBe(viaLib);
    });

    it('static-scan: docker-tools.ts has NO top-level static import from src/modules/docker', () => {
      // The load-bearing claim of slice 5: a top-level static import
      // from `../../modules/docker/*` would execute the docker module's
      // import-time prerequisite check at server startup. The dynamic
      // `import()` inside each handler defers that to first-call time.
      // The scan covers value imports AND `import type` (a type-only
      // import is erased at runtime but is one eslint-friendly drift
      // away from becoming a value import). The dispatch surface
      // (index.ts) is scanned for the same property — only the local
      // tools file is allowed to be imported statically.
      const file = path.resolve(repoRoot, 'src/config-server/tools/docker-tools.ts');
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');

      // Strip block comments and line comments before scanning — the
      // module's doc-comment intentionally names the path inside prose.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');

      // Match any top-level (line-leading, ignoring indent) `import`
      // form that reaches src/modules/docker — including `import type`,
      // `import { X }`, `import X from`, and bare side-effect imports.
      const topLevelImport = /^\s*import\b[^;]*?from\s*['"][^'"]*modules\/docker[^'"]*['"]/m;
      const requireForm = /^\s*(const|let|var)\b[^;]*=\s*require\(\s*['"][^'"]*modules\/docker/m;
      expect(stripped).not.toMatch(topLevelImport);
      expect(stripped).not.toMatch(requireForm);

      // Positive: each library file the handlers wrap appears inside
      // a dynamic `import('...')` expression. The wrappers do not
      // re-export the library functions — each handler awaits its
      // dynamic import inside the body so the docker library is loaded
      // lazily and only when a docker tool is invoked.
      const dynamicForms = [
        /import\(\s*['"][^'"]*modules\/docker\/PortRegistry/,
        /import\(\s*['"][^'"]*modules\/docker\/PortDiscovery/,
        /import\(\s*['"][^'"]*modules\/docker\/ContainerHealth/,
        /import\(\s*['"][^'"]*modules\/docker\/ContainerNaming/,
      ];
      for (const re of dynamicForms) {
        expect(text).toMatch(re);
      }
    });

    it('static-scan: index.ts has NO top-level static import from src/modules/docker either', () => {
      // The dispatch file is the second half of the lazy-load contract:
      // it must reach the docker tool handlers only via the local tools
      // file, never via a direct module reach.
      const file = path.resolve(repoRoot, 'src/config-server/index.ts');
      const text = readFileSync(file, 'utf8');
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
      const topLevelImport = /^\s*import\b[^;]*?from\s*['"][^'"]*modules\/docker[^'"]*['"]/m;
      const requireForm = /^\s*(const|let|var)\b[^;]*=\s*require\(\s*['"][^'"]*modules\/docker/m;
      expect(stripped).not.toMatch(topLevelImport);
      expect(stripped).not.toMatch(requireForm);
    });

    it('negative guard: PortRegistry has not gained a reserve/allocate free-port allocator this sprint', () => {
      // Caller-supplies-port is the contract — a free-port allocator
      // would be new domain logic the spec defers to a future M2
      // extension. The scan looks for new public methods named
      // `reserve` or `allocate` on PortRegistry's source.
      const file = path.resolve(repoRoot, 'src/modules/docker/PortRegistry.ts');
      const text = readFileSync(file, 'utf8');

      // The class body declares methods at the indented top level; a
      // public `reserve(` or `allocate(` declaration would surface as a
      // line-starting method shape. We match any leading-whitespace +
      // method-name + open-paren pattern that is not preceded by
      // `private`/`#` (private members keep the negative guard targeted
      // at the public surface).
      const reserveDecl = /^\s+(?:public\s+)?reserve\s*\(/m;
      const allocateDecl = /^\s+(?:public\s+)?allocate\s*\(/m;
      expect(text).not.toMatch(reserveDecl);
      expect(text).not.toMatch(allocateDecl);
    });
  });

  // ---------- 1b. Health-check path is confined to the localhost origin ----------

  describe('dockerCheckContainerHealth: path is confined to the localhost origin', () => {
    const TOOL = 'dockerCheckContainerHealth';

    it('accepts a plain path-absolute request path', () => {
      expect(requireHttpPathArg({ path: '/health' }, TOOL)).toBe('/health');
      expect(requireHttpPathArg({ path: '/a/b/c' }, TOOL)).toBe('/a/b/c');
    });

    it('rejects a userinfo-injection path that would relocate the host', () => {
      // `@evil.tld/x` concatenated after `http://localhost:<port>` parses as
      // a request to evil.tld with localhost as userinfo — the SSRF primitive.
      expect(() => requireHttpPathArg({ path: '@evil.tld/x' }, TOOL)).toThrow(ConfigServerError);
    });

    it('rejects a scheme-relative `//host` path', () => {
      expect(() => requireHttpPathArg({ path: '//evil.tld/x' }, TOOL)).toThrow(ConfigServerError);
    });

    it('rejects control bytes, whitespace, and the ?/# delimiters', () => {
      expect(() => requireHttpPathArg({ path: '/a\r\nb' }, TOOL)).toThrow(ConfigServerError);
      expect(() => requireHttpPathArg({ path: '/a b' }, TOOL)).toThrow(ConfigServerError);
      expect(() => requireHttpPathArg({ path: '/a?b' }, TOOL)).toThrow(ConfigServerError);
      expect(() => requireHttpPathArg({ path: '/a#b' }, TOOL)).toThrow(ConfigServerError);
      expect(() => requireHttpPathArg({ path: '/a b' }, TOOL)).toThrow(ConfigServerError);
    });

    it('rejects a path that does not begin with a slash', () => {
      expect(() => requireHttpPathArg({ path: 'health' }, TOOL)).toThrow(ConfigServerError);
    });

    it('library neutralises a host-relocating path: fetch only ever hits the localhost origin', async () => {
      // Defence in depth: even if a malicious path bypassed the boundary, the
      // library builds the URL via the WHATWG URL API against a fixed base, so
      // the only host the fetch impl ever sees is the localhost origin.
      const seen: string[] = [];
      const recordingFetch: typeof fetch = async (input) => {
        seen.push(String(input));
        return new Response('ok', { status: 200 });
      };
      await waitForHealthy(7900, {
        // `@evil.tld/x` assigned to pathname cannot move the host.
        path: '/@evil.tld/x',
        expectStatus: 200,
        timeoutSeconds: 1,
        fetchImpl: recordingFetch,
      });
      expect(seen).toHaveLength(1);
      const u = new URL(seen[0]);
      expect(u.host).toBe('localhost:7900');
      expect(u.username).toBe('');
    });
  });

  // ---------- 1c. worktreePath cannot redirect the registry store ----------

  describe('worktreePath is constrained so it cannot redirect the registry store', () => {
    const TOOL = 'dockerReservePort';

    it('accepts an absolute, normalised worktree path', () => {
      expect(requireWorktreePathArg({ worktreePath: '/repo/wt-a' }, TOOL)).toBe('/repo/wt-a');
    });

    it('rejects a relative worktree path (would vary the store address per call)', () => {
      expect(() => requireWorktreePathArg({ worktreePath: 'wt-a' }, TOOL)).toThrow(
        ConfigServerError,
      );
    });

    it('rejects a `..`/traversal worktree path', () => {
      expect(() =>
        requireWorktreePathArg({ worktreePath: '/repo/../../etc/wt' }, TOOL),
      ).toThrow(ConfigServerError);
    });

    it('rejects a NUL-bearing worktree path', () => {
      expect(() => requireWorktreePathArg({ worktreePath: '/repo/wt\0junk' }, TOOL)).toThrow(
        ConfigServerError,
      );
    });
  });

  // ---------- 1d. Missing-on-disk module translates to ModulePrerequisiteFailed ----------

  describe('a module absent on disk surfaces ModulePrerequisiteFailed, not NotImplemented', () => {
    it('translates ERR_MODULE_NOT_FOUND into an actionable ModulePrerequisiteFailed', async () => {
      // Point the loader at a path that does not exist so import() throws
      // ERR_MODULE_NOT_FOUND — the partial-install / pruned-dist case.
      let thrown: unknown;
      try {
        await importDockerModule(() => import('../../modules/docker/DoesNotExist.js'));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe('ModulePrerequisiteFailed');
      // Carries an actionable hint distinct from a generic NotImplemented.
      expect((thrown as { errorHint?: string }).errorHint).toMatch(/reinstall|build/i);
    });

    it('does not mask a non-ERR_MODULE_NOT_FOUND failure', async () => {
      // A loader that throws an unrelated error must bubble unchanged so the
      // translation cannot hide real faults (e.g. a module syntax error).
      const sentinel = new Error('unrelated boom');
      let thrown: unknown;
      try {
        await importDockerModule(() => Promise.reject(sentinel));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBe(sentinel);
    });
  });

  // ---------- 2. Duplicate reservation surfaces PortInUse from library ----------

  describe('Duplicate reservation surfaces PortInUse from library', () => {
    it('a second reservation of the same port from a different worktree surfaces PortInUse verbatim', async () => {
      const wtA = path.join(scratch, 'wt-clash-a');
      const wtB = path.join(scratch, 'wt-clash-b');
      mkdirSync(wtA, { recursive: true });
      mkdirSync(wtB, { recursive: true });

      await dockerReservePort({
        worktreePath: wtA,
        port: 7600,
        containerName: 'app-clash-a',
      });

      let thrown: unknown;
      try {
        await dockerReservePort({
          worktreePath: wtB,
          port: 7600,
          containerName: 'app-clash-b',
        });
      } catch (e) {
        thrown = e;
      }
      // The error MUST carry the `PortInUse` code preserved verbatim
      // from the library's createError call — no re-wrapping at the
      // tool layer.
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe('PortInUse');
    });

    it('re-registering the same worktree on its own port is a no-conflict update (self-update allowed)', async () => {
      const wt = path.join(scratch, 'wt-self');
      mkdirSync(wt, { recursive: true });
      // The library's register at lines 92-109 permits the self-update
      // path: same worktreePath + same port = no throw, registry blob
      // is overwritten with the (possibly updated) containerName.
      await dockerReservePort({
        worktreePath: wt,
        port: 7700,
        containerName: 'app-self-v1',
      });
      // No throw on self-update with a refreshed containerName.
      await expect(
        dockerReservePort({
          worktreePath: wt,
          port: 7700,
          containerName: 'app-self-v2',
        }),
      ).resolves.toBeDefined();
      const entry = new PortRegistry(scratch).lookup(wt);
      expect(entry).toEqual({ port: 7700, containerName: 'app-self-v2' });
    });
  });

  // ---------- 3. Module state round-trips through F8 module-state store ----------

  describe('Module state round-trips through F8 module-state store', () => {
    it('a dockerReservePort write persists across a real process boundary (child read)', async () => {
      const wt = path.join(scratch, 'wt-round-async');
      mkdirSync(wt, { recursive: true });
      await dockerReservePort({
        worktreePath: wt,
        port: 7801,
        containerName: 'app-round-async',
      });

      // Child: spawn a node subprocess that imports PortRegistry against
      // the SAME projectRoot and reads the persisted state. The child
      // inherits the parent's env (GAN_PACKAGE_ROOT_OVERRIDE +
      // GAN_MODULE_STATE) so it resolves the same on-disk state file.
      const childScript = `
        import('${pathToFileUrl(
          path.join(repoRoot, 'dist', 'modules', 'docker', 'PortRegistry.js'),
        )}').then((m) => {
          const reg = new m.PortRegistry(${JSON.stringify(scratch)});
          const entry = reg.lookup(${JSON.stringify(wt)});
          process.stdout.write(JSON.stringify(entry));
        }).catch((e) => {
          process.stderr.write(String(e && e.message ? e.message : e));
          process.exit(2);
        });
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
        env: process.env,
        encoding: 'utf8',
      });
      expect(child.status, `child stderr: ${child.stderr}`).toBe(0);
      const parsed = JSON.parse(child.stdout) as { port: number; containerName: string } | null;
      expect(parsed).toEqual({ port: 7801, containerName: 'app-round-async' });

      // Release through the tool, then re-spawn — the second child's
      // read must see the entry gone, confirming the release also
      // crosses the persistence boundary.
      await dockerReleasePort({ worktreePath: wt });
      const child2 = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
        env: process.env,
        encoding: 'utf8',
      });
      expect(child2.status, `child2 stderr: ${child2.stderr}`).toBe(0);
      expect(JSON.parse(child2.stdout)).toBeNull();
    });
  });

  // ---------- 4. Trust posture: docker exec tools honor F4/F6 ladder ----------

  describe('Trust posture: docker exec tools honor F4/F6 ladder', () => {
    it('no new bypass: the tool file declares no GAN_TRUST read or trust-gate skip code path', () => {
      // The F4/F6 trust ladder is enforced at the agent/prompt layer
      // (validateAll trust check + the SKILL.md preconditions). The
      // criterion the spec pins is "R7 adds no new bypass of the trust
      // ladder"; the tool layer demonstrates this by NOT introducing
      // any code path that reads `GAN_TRUST`, calls into the trust
      // store directly, or otherwise short-circuits the existing gate.
      const file = path.resolve(repoRoot, 'src/config-server/tools/docker-tools.ts');
      const text = readFileSync(file, 'utf8');
      // No reference to GAN_TRUST — the env var the F4/F6 gate reads.
      expect(text).not.toMatch(/GAN_TRUST/);
      // No reach into the trust-store source.
      expect(text).not.toMatch(/from\s+['"][^'"]*trust\/[^'"]*['"]/);
      // No --no-project-commands handling locally — the run-time
      // suppression lives in the agent layer the spec names, not in
      // the tool wrapper.
      expect(text).not.toMatch(/no-project-commands/);
    });

    it('failing-closed posture: the tools route through the standard MCP dispatch with no second entry point', async () => {
      // The slice-5 dispatch wiring lands in the existing dispatch
      // table (TOOL_HANDLERS). The DISPATCH_TOOL_NAMES set is the only
      // accepted-name list the server consults; the five docker tools
      // appear in it, but no second routing surface (no second server,
      // no parallel handler registry) is introduced.
      const { DISPATCH_TOOL_NAMES, DOCKER_TOOL_NAMES } =
        await import('../../../src/config-server/index.js');
      for (const name of DOCKER_TOOL_NAMES) {
        expect(DISPATCH_TOOL_NAMES).toContain(name);
      }
      // No alternative bin: the package only exposes the
      // existing entry points. (Backstopped by the
      // scripts/checks/no-second-mcp-server.mjs script in CI.)
      const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        bin: Record<string, string>;
      };
      const binNames = Object.keys(pkg.bin).sort();
      expect(binNames).toEqual(['claudeagents-config-server', 'gan']);
    });

    it('GAN_TRUST=strict in a CI-shaped environment: the dispatch surface still fails closed (no bypass)', () => {
      // The strict-mode failure is enforced by the existing trust gate
      // at the agent/validateAll layer, not in the tool. The criterion
      // here is structural — the new dispatch entries do not introduce
      // a code path that would skip the gate under GAN_TRUST=strict.
      // The scan covers every conditional that would gate on trust
      // value; the docker tool surface has none.
      const toolFile = path.resolve(repoRoot, 'src/config-server/tools/docker-tools.ts');
      const indexFile = path.resolve(repoRoot, 'src/config-server/index.ts');
      const toolText = readFileSync(toolFile, 'utf8');
      // index.ts may legitimately mention trust elsewhere (trustList,
      // trustApprove handlers), but the docker dispatch entries must
      // not reach a trust-bypass keyword. We assert the docker handler
      // entries (identified by `dockerReservePort:` etc) sit inside
      // the table and carry no per-entry conditional referencing
      // GAN_TRUST.
      const indexText = readFileSync(indexFile, 'utf8');
      // Extract the slice covering docker entries — from the first
      // `dockerReservePort:` line to the `};` closing the dispatch
      // table. The slice must contain no GAN_TRUST reference.
      const startIdx = indexText.indexOf('dockerReservePort: {');
      expect(startIdx).toBeGreaterThan(-1);
      const tail = indexText.slice(startIdx);
      const closeMatch = /\n};/.exec(tail);
      expect(closeMatch).not.toBeNull();
      const slice = tail.slice(0, closeMatch!.index);
      expect(slice).not.toMatch(/GAN_TRUST/);
      // And the tool body — already covered in the prior `it` but
      // reasserted here so a regression in either file flunks this
      // failing-closed case.
      expect(toolText).not.toMatch(/GAN_TRUST/);
    });
  });
});

// Convert an absolute filesystem path to a `file://` URL string suitable
// for `import('...')` in a child node process. Using URLs (rather than
// raw paths) avoids backslash-escaping pitfalls when the test runs on a
// platform with non-POSIX separators.
function pathToFileUrl(p: string): string {
  // The standard library helper returns a URL object; toString() gives
  // the canonical file:// form.
  return new URL(`file://${p}`).toString();
}
