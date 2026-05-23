/**
 * End-to-end tests for the "framework library unreachable" failure mode
 * (acceptance criterion F-AC6).
 *
 * The CLI is a thin wrapper over the framework library it imports from `dist/`.
 * If that library cannot be loaded or its calls throw at runtime, the CLI must
 * fail gracefully: exit code 5 (the dedicated ApiUnreachable class), a
 * remediation hint on stderr pointing at `install.sh`, no partial stdout, and —
 * under `--json` — a structured `{ code: 'ApiUnreachable', ... }` on stdout with
 * clean stderr. The remediation text must also obey the F4 prose discipline (no
 * bare npm/node/Node/MCP server tokens). This is exercised for `version` and
 * every read/write command, since all of them route through the library.
 *
 * To simulate the fault hermetically, {@link buildBrokenDist} assembles a
 * throwaway dist tree that mirrors the real one but swaps the library modules
 * for stubs that throw "framework library missing (test stub)". The CLI is then
 * spawned against that broken entry via `entryOverride`, so the real install is
 * never disturbed.
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Teardown thunks (rmSync of each broken-dist temp tree), drained per test.
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

/**
 * Assemble a throwaway `dist` tree that is structurally valid but whose
 * framework-library modules are stubs that throw. Returns the path to the
 * broken CLI entrypoint to spawn via `entryOverride`.
 *
 * The CLI's own `dist/cli` is copied verbatim (we are testing the real CLI), but
 * the modules it imports — `config-server/index.js`, the storage helpers,
 * `dist/index.js`, etc. — are replaced with stubs whose every export throws the
 * "framework library missing" error, modelling a broken/partial install. A
 * `node_modules` symlink and a minimal `package.json` make the tree resolvable.
 * Note: the string bodies written below are stub source DATA, not comments.
 */
function buildBrokenDist(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gan-unreachable-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

  const tmpPkg = {
    name: 'gan-unreachable-fixture',
    type: 'module',
  };
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(tmpPkg, null, 2) + '\n');

  // Symlink the real node_modules so the copied CLI can still resolve its
  // third-party deps without a duplicate install.
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

  // Copy the real CLI verbatim — it is the code under test; only the library it
  // calls into is stubbed below.
  const distSrc = path.join(repoRoot, 'dist', 'cli');
  const distDest = path.join(tmp, 'dist', 'cli');
  cpSync(distSrc, distDest, { recursive: true });

  // determinism/ and errors are copied real (not stubbed): the CLI's error
  // handling needs the genuine ConfigServerError class and canonicalisation to
  // even reach — and correctly classify — the stubbed throws.
  const csDir = path.join(tmp, 'dist', 'config-server');
  const csDeterminismDir = path.join(csDir, 'determinism');
  cpSync(path.join(repoRoot, 'dist', 'config-server', 'determinism'), csDeterminismDir, {
    recursive: true,
  });

  cpSync(path.join(repoRoot, 'dist', 'config-server', 'errors.js'), path.join(csDir, 'errors.js'));
  cpSync(
    path.join(repoRoot, 'dist', 'config-server', 'errors.d.ts'),
    path.join(csDir, 'errors.d.ts'),
  );
  writeFileSync(
    path.join(csDir, 'index.js'),
    `export async function getApiVersion() {
  throw new Error('framework library missing (test stub)');
}
`,
  );
  writeFileSync(
    path.join(csDir, 'index.d.ts'),
    'export function getApiVersion(): Promise<{apiVersion:string}>;\n',
  );

  const csStorageDir = path.join(csDir, 'storage');
  mkdirSync(csStorageDir, { recursive: true });
  writeFileSync(
    path.join(csStorageDir, 'atomic-write.js'),
    `export function atomicWriteFile() { throw new Error('framework library missing (test stub)'); }\n`,
  );
  writeFileSync(
    path.join(csStorageDir, 'atomic-write.d.ts'),
    'export function atomicWriteFile(target: string, content: string): void;\n',
  );

  writeFileSync(
    path.join(csDir, 'package-root.js'),
    `export function packageRoot() { throw new Error('framework library missing (test stub)'); }\n`,
  );
  writeFileSync(path.join(csDir, 'package-root.d.ts'), 'export function packageRoot(): string;\n');
  writeFileSync(
    path.join(csStorageDir, 'yaml-block-parser.js'),
    `export function parseYamlBlock() { throw new Error('framework library missing (test stub)'); }\n`,
  );
  writeFileSync(
    path.join(csStorageDir, 'yaml-block-parser.d.ts'),
    'export function parseYamlBlock(text: string, filePath?: string): unknown;\n',
  );

  writeFileSync(
    path.join(csDir, 'scaffold-banner.js'),
    `export const DRAFT_BANNER = '# DRAFT (test-stub)';\n`,
  );
  writeFileSync(path.join(csDir, 'scaffold-banner.d.ts'), 'export const DRAFT_BANNER: string;\n');

  const distIndex = path.join(tmp, 'dist', 'index.js');
  writeFileSync(
    distIndex,
    [
      'function unreachable() {',
      "  throw new Error('framework library missing (test stub)');",
      '}',
      'export const getResolvedConfig = unreachable;',
      'export const getActiveStacks = unreachable;',
      'export const getStack = unreachable;',
      'export const listModules = unreachable;',
      'export const getOverlay = unreachable;',
      'export const getStackResolution = unreachable;',
      'export const getMergedSplicePoints = unreachable;',
      'export const getModuleState = unreachable;',
      'export const getTrustState = unreachable;',
      'export const getTrustDiff = unreachable;',

      'export const setOverlayField = unreachable;',
      'export const updateStackField = unreachable;',

      'export const validateAll = unreachable;',

      'export const trustApprove = unreachable;',
      'export const trustRevoke = unreachable;',
      'export const trustList = unreachable;',
      'export { getApiVersion } from "./config-server/index.js";',
      '',
    ].join('\n'),
  );

  return path.join(tmp, 'dist', 'cli', 'index.js');
}

describe('gan: framework library unreachable', () => {
  it('F-AC6: `gan version` exits 5 with a remediation hint pointing at install.sh', async () => {
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version'], { entryOverride: brokenEntry });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot reach the framework's library");
    expect(r.stderr).toContain('install.sh');
  });

  it('F-AC6: even with --json, the unreachable error surfaces on stderr (no JSON on stdout)', async () => {

    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version', '--json'], { entryOverride: brokenEntry });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot reach the framework's library");
  });

  it('F-AC6: remediation text obeys the F4 prose discipline', async () => {
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version'], { entryOverride: brokenEntry });

    // Even on the error path the prose discipline holds: no bare npm/node tokens
    // (a backtick-quoted occurrence is allowed; the lookarounds exclude those).
    const proseToken = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;
    const violations = [...r.stderr.matchAll(proseToken)];
    expect(violations).toHaveLength(0);

    expect(r.stderr).toMatch(/framework/i);
  });

  // Every read AND write command routes through the framework library, so each
  // must surface the same exit-5 ApiUnreachable failure when it is broken. The
  // table is driven through two generated tests per command (human + --json).
  const READ_COMMANDS: Array<{ name: string; argv: string[] }> = [
    {
      name: 'config print',
      argv: [
        'config',
        'print',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'config get',
      argv: [
        'config',
        'get',
        'apiVersion',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'stacks list',
      argv: [
        'stacks',
        'list',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'stack show',
      argv: [
        'stack',
        'show',
        'web-node',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'modules list',
      argv: [
        'modules',
        'list',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },

    {
      name: 'config set',
      argv: [
        'config',
        'set',
        'runner.thresholdOverride',
        '8',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'stack update',
      argv: [
        'stack',
        'update',
        'web-node',
        'lintCmd',
        'whatever',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
  ];

  for (const c of READ_COMMANDS) {
    it(`F-AC6: \`gan ${c.name}\` exits 5 under unreachable framework library`, async () => {
      const brokenEntry = buildBrokenDist();
      const r = await runGan(c.argv, { entryOverride: brokenEntry });
      expect(r.exitCode).toBe(5);

      expect(r.stderr).toContain("cannot reach the framework's library");
      expect(r.stderr).toContain('install.sh');

      expect(r.stdout).toBe('');
    });

    it(`F-AC6: \`gan ${c.name} --json\` exits 5 with structured error on stdout`, async () => {
      const brokenEntry = buildBrokenDist();
      const r = await runGan([...c.argv, '--json'], { entryOverride: brokenEntry });
      expect(r.exitCode).toBe(5);

      // Under --json the failure is structured on stdout and stderr stays clean,
      // mirroring the success-path stream discipline.
      expect(r.stderr).toBe('');
      const parsed = JSON.parse(r.stdout) as { code: string; message: string };
      expect(parsed.code).toBe('ApiUnreachable');
      expect(parsed.message).toContain("cannot reach the framework's library");
    });
  }

  // Guard against the broken-dist scaffolding silently drifting from reality:
  // confirm the real CLI entry exists and is an executable script (shebang), so
  // the tests above are exercising a genuine entrypoint shape.
  it('sanity: the test fixture references real paths', () => {
    const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
    const head = readFileSync(cliEntry, 'utf8').slice(0, 50);
    expect(head).toContain('#!/usr/bin/env');
  });
});
