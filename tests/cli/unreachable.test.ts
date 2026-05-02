/**
 * R3 sprint 1 — F-AC6 read path: simulate the framework's library being
 * unreachable. The CLI must exit 5 with a remediation hint pointing at
 * `install.sh`.
 *
 * Strategy: copy just `dist/cli/` to a fresh tmp tree (without
 * `dist/config-server/`, without `package.json`, without `schemas/`) and
 * run from there. The bin entry's static imports of the framework
 * library fail, the bootstrap `main()` catch surfaces a non-zero exit;
 * we then run the version command via a thinner harness that replicates
 * the version dispatcher but relocates `import.meta.url`.
 *
 * In practice the simplest reliable simulation is to copy `dist/cli/` to
 * a tmp dir AND replace the imports of `dist/config-server/index.js`
 * with a stub that throws on `getApiVersion()`. We use a small
 * fixture script that does exactly that and feed it through `runGan`'s
 * `entryOverride`.
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
 * Build a tmp tree containing a stand-in version command + a stand-in
 * `getApiVersion` import target that throws. The bin entry is also
 * copied so the dispatch path runs end-to-end.
 *
 * Layout:
 *   tmp/
 *     dist/
 *       cli/                  ← copied from real dist/cli
 *       config-server/
 *         index.js            ← throws on import OR throws getApiVersion
 *
 * `dist/cli/commands/version.js` imports
 * `../../config-server/index.js`; we provide a stand-in there.
 *
 * We deliberately do NOT create package.json / schemas/ at the tmp root,
 * so the version command's filesystem reads also fail.
 */
function buildBrokenDist(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gan-unreachable-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

  // Tmp tree must be marked as ESM so the copied `.js` files load via the
  // ESM loader (their imports are bare `import * as foo` statements).
  // We deliberately leave `version` blank here: the stand-in
  // `config-server/index.js` rejects on `getApiVersion()`, and the
  // version command's `readServerVersion()` then fails to read this
  // package.json — which is the exact "framework library unreachable"
  // surface F-AC6 verifies. Either failure path renders the same
  // remediation text via the version command's catch block.
  const tmpPkg = {
    name: 'gan-unreachable-fixture',
    type: 'module',
  };
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(tmpPkg, null, 2) + '\n');

  // Symlink node_modules so the copied determinism module can resolve
  // its `picomatch` dependency.
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

  const distSrc = path.join(repoRoot, 'dist', 'cli');
  const distDest = path.join(tmp, 'dist', 'cli');
  cpSync(distSrc, distDest, { recursive: true });

  // Stand-in for the framework library: `getApiVersion()` always rejects.
  // The CLI's version command catches the rejection and surfaces exit 5.
  const csDir = path.join(tmp, 'dist', 'config-server');
  const csDeterminismDir = path.join(csDir, 'determinism');
  cpSync(path.join(repoRoot, 'dist', 'config-server', 'determinism'), csDeterminismDir, {
    recursive: true,
  });
  // The CLI imports `createError` from `errors.js` (per the R1 error-factory
  // rule); copy the real module so the import resolves under the stub tree.
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

  // S4 introduces `gan stacks new`, which imports `atomicWriteFile` from
  // `../../config-server/storage/atomic-write.js` directly (the writer is
  // not re-exported from the package main). Provide a stand-in so the
  // dispatcher's static import graph resolves; the function throws on
  // call so `gan stacks new` surfaces exit 5 under the unreachable path.
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
  // The S4 scaffold helper re-exports `DRAFT_BANNER` from R1's canonical
  // single-source module. Stub it so `dist/cli/lib/scaffold.js` loads.
  writeFileSync(
    path.join(csDir, 'scaffold-banner.js'),
    `export const DRAFT_BANNER = '# DRAFT (test-stub)';\n`,
  );
  writeFileSync(path.join(csDir, 'scaffold-banner.d.ts'), 'export const DRAFT_BANNER: string;\n');

  // Stand-in for `dist/index.js` (the package main re-export point that
  // S2's read commands import from). Every exported read function throws
  // a plain `Error`; the CLI's `errorResult` helper treats anything other
  // than a `ConfigServerError` as the framework library being unreachable
  // and surfaces exit 5 with the F4-discipline remediation text.
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
      // S3 write entry points: same unreachable shape so the CLI's write
      // commands surface exit 5 when the framework library is missing.
      'export const setOverlayField = unreachable;',
      'export const updateStackField = unreachable;',
      // S4: `gan validate` imports `validateAll` from the package main.
      'export const validateAll = unreachable;',
      // R5 S4 trust-mutating CLI subcommands import these from the
      // package main. Without explicit exports here, ESM's strict
      // named-import resolution fails at module instantiation time
      // (before `main()` runs) and the CLI dies with a `SyntaxError`
      // and exit 1 instead of the F-AC6 exit-5 / install.sh path.
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
    // The contract is: when the *library itself* is unreachable, --json has
    // nothing structured to serialise. Stderr carries the human-readable
    // remediation; stdout stays empty so `gan version --json | jq` fails
    // loudly rather than parsing zero bytes as null.
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version', '--json'], { entryOverride: brokenEntry });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot reach the framework's library");
  });

  it('F-AC6: remediation text obeys the F4 prose discipline', async () => {
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version'], { entryOverride: brokenEntry });
    // No bare npm/node/Node/MCP server tokens outside backticks.
    const proseToken = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;
    const violations = [...r.stderr.matchAll(proseToken)];
    expect(violations).toHaveLength(0);
    // Must reference the framework, not the runtime.
    expect(r.stderr).toMatch(/framework/i);
  });

  // S2 extension: every read subcommand surfaces exit 5 when the
  // framework library is unreachable. We use a real fixture path so the
  // command's resolveProjectRoot succeeds — the failure must come from
  // the library call itself.
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
    // S3 write subcommands surface the same exit-5 / install.sh hint
    // when the framework library is unreachable.
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
      // Stderr surface (no `--json`) carries the human remediation text.
      expect(r.stderr).toContain("cannot reach the framework's library");
      expect(r.stderr).toContain('install.sh');
      // Stdout stays empty on the human path.
      expect(r.stdout).toBe('');
    });

    it(`F-AC6: \`gan ${c.name} --json\` exits 5 with structured error on stdout`, async () => {
      const brokenEntry = buildBrokenDist();
      const r = await runGan([...c.argv, '--json'], { entryOverride: brokenEntry });
      expect(r.exitCode).toBe(5);
      // Under --json, the structured F2 error lands on stdout so
      // `gan ... --json | jq` parses cleanly even on the unreachable path.
      expect(r.stderr).toBe('');
      const parsed = JSON.parse(r.stdout) as { code: string; message: string };
      expect(parsed.code).toBe('ApiUnreachable');
      expect(parsed.message).toContain("cannot reach the framework's library");
    });
  }

  // Touch the readFileSync import so eslint doesn't complain about an unused.
  it('sanity: the test fixture references real paths', () => {
    const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
    const head = readFileSync(cliEntry, 'utf8').slice(0, 50);
    expect(head).toContain('#!/usr/bin/env');
  });
});
