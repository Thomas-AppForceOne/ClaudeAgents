/**
 * The core validation suite — the three public validators (validateAll,
 * validateStack, validateOverlay), the phase-1 discovery seam, and the same
 * validateAll over the MCP stdio transport. It is the broadest behavioural
 * contract for what counts as valid config and how problems are reported.
 *
 * Major guarantees exercised here:
 *   - clean fixtures produce zero issues (no false positives);
 *   - each malformed fixture yields its specific issue code with file-path and
 *     field provenance (SchemaMismatch, InvalidYAML, MissingFile), and the
 *     schemaVersion=999 fixture surfaces the version mismatch with the number
 *     in the message;
 *   - validation is collecting, not fail-fast: one bad file does not throw or
 *     halt the run, and a file with several violations yields several issues;
 *   - multi-invariant runs surface every invariant at once (cacheEnv +
 *     PathEscape together);
 *   - user-tier forbidden fields (C3): planner/proposer additionalContext and
 *     stack.override/cacheEnvOverride are each rejected at the user tier with
 *     MalformedInput, and when all four are declared they come back as exactly
 *     four issues in a deterministic field order;
 *   - validateStack/validateOverlay scope down to a single artefact (note that
 *     the overlay validator does NOT do the cross-reference MissingFile check —
 *     that lives only in validateAll, asserted explicitly here);
 *   - phase-1 discovery finds built-in stacks from BOTH packageRoot/stacks and
 *     projectRoot/stacks (dual fallback);
 *   - the same validateAll answer comes back over the JSON-RPC stdio transport
 *     (subprocess), which is skipped gracefully when the dist build is absent.
 *
 * User-tier overlays are written into throwaway temp homes (makeUserHomeWithOverlay)
 * so the forbidden-field checks never read the developer's real home.
 */

import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import {
  validateAll,
  validateOverlay,
  validateStack,
  _runPhase1ForTests,
  type Issue,
} from '../../../src/config-server/tools/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const jsTsMinimal = path.join(fixturesRoot, 'js-ts-minimal');
const invalidSchemaMismatch = path.join(fixturesRoot, 'invalid-schema-mismatch');
const invalidMalformedYaml = path.join(fixturesRoot, 'invalid-malformed-yaml');
const invalidMissingFile = path.join(fixturesRoot, 'invalid-missing-file');
const invalidStackResolution = path.join(fixturesRoot, 'invalid-stack-resolution');
const invariantMultiViolation = path.join(fixturesRoot, 'invariant-multi-violation');

function findIssue(issues: Issue[], predicate: (i: Issue) => boolean): Issue | undefined {
  return issues.find(predicate);
}

const tmpUserHomes: string[] = [];

function makeUserHomeWithOverlay(body: string): string {
  const userHome = mkdtempSync(path.join(tmpdir(), 'cas-validate-userhome-'));
  tmpUserHomes.push(userHome);
  const ganDir = path.join(userHome, '.claude', 'gan');
  mkdirSync(ganDir, { recursive: true });
  writeFileSync(path.join(ganDir, 'user.md'), body);
  return userHome;
}

afterEach(() => {
  for (const d of tmpUserHomes.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('validateAll', () => {
  it('returns no issues for a clean fixture (js-ts-minimal)', () => {
    const result = validateAll({ projectRoot: jsTsMinimal });
    expect(result.issues).toEqual([]);
  });

  it('reports SchemaMismatch with field provenance for invalid-schema-mismatch', () => {
    const result = validateAll({ projectRoot: invalidSchemaMismatch });
    const schemaMismatches = result.issues.filter((i) => i.code === 'SchemaMismatch');
    expect(schemaMismatches.length).toBeGreaterThan(0);

    for (const issue of schemaMismatches) {
      expect(typeof issue.field).toBe('string');
      expect((issue.field ?? '').length).toBeGreaterThan(0);
      expect(issue.path).toContain('web-node.md');
    }
  });

  it('returns multiple issues for a file with multiple schema violations', () => {

    const result = validateAll({ projectRoot: invalidSchemaMismatch });
    const issuesForFile = result.issues.filter(
      (i) => i.code === 'SchemaMismatch' && (i.path ?? '').endsWith('web-node.md'),
    );
    expect(issuesForFile.length).toBeGreaterThanOrEqual(2);

    const mentionsTemplate = issuesForFile.some(
      (i) => i.message.includes('template') || (i.field ?? '').includes('securitySurfaces'),
    );
    const mentionsSecrets = issuesForFile.some(
      (i) => i.message.includes('secrets') || (i.field ?? '').includes('secretsGlob'),
    );
    expect(mentionsTemplate).toBe(true);
    expect(mentionsSecrets).toBe(true);
  });

  it('reports InvalidYAML for invalid-malformed-yaml', () => {
    const result = validateAll({ projectRoot: invalidMalformedYaml });
    const invalidYaml = findIssue(result.issues, (i) => i.code === 'InvalidYAML');
    expect(invalidYaml).toBeTruthy();
    expect(invalidYaml!.path).toContain('web-node.md');
    expect(invalidYaml!.message.length).toBeGreaterThan(0);
  });

  it('reports MissingFile when a project overlay references an unknown stack', () => {
    const result = validateAll({ projectRoot: invalidMissingFile });
    const missing = findIssue(result.issues, (i) => i.code === 'MissingFile');
    expect(missing).toBeTruthy();
    expect(missing!.message).toContain('never-defined-stack');

    expect(missing!.path).toContain('project.md');
  });

  it('reports SchemaMismatch on the schemaVersion=999 fixture', () => {
    const result = validateAll({ projectRoot: invalidStackResolution });
    const mismatch = findIssue(
      result.issues,
      (i) => i.code === 'SchemaMismatch' && (i.field ?? '').includes('schemaVersion'),
    );
    expect(mismatch).toBeTruthy();
    expect(mismatch!.message).toContain('999');
  });

  it('does not halt the pipeline on a single bad file (collects across the project)', () => {
    // A schema-violating file must be reported, never thrown — validation
    // collects issues across the whole project rather than aborting on the first.
    expect(() => validateAll({ projectRoot: invalidSchemaMismatch })).not.toThrow();
  });

  it('surfaces both invariants in one run for the invariant-multi-violation fixture', () => {

    const result = validateAll({ projectRoot: invariantMultiViolation });
    const cacheEnvFired = result.issues.find(
      (i) =>
        i.code === 'InvariantViolation' &&
        (i.field ?? '') === '/cacheEnv' &&
        i.message.includes('NODE_VERSION'),
    );
    const pathEscapeFired = result.issues.find(
      (i) =>
        i.code === 'PathEscape' &&
        (i.field ?? '') === '/proposer/additionalContext' &&
        i.message.includes('outside the project root'),
    );
    expect(cacheEnvFired).toBeTruthy();
    expect(pathEscapeFired).toBeTruthy();
  });
});

describe('validateAll — user-tier forbidden fields (C3 lines 71-75)', () => {
  it('reports MalformedInput for planner.additionalContext at user tier', () => {
    const userHome = makeUserHomeWithOverlay(
      `---
schemaVersion: 1
planner:
  additionalContext:
    - "~/notes.md"
---
`,
    );
    const result = validateAll({ projectRoot: jsTsMinimal }, { userHome });
    const forbidden = result.issues.filter(
      (i) => i.code === 'MalformedInput' && i.field === 'planner.additionalContext',
    );
    expect(forbidden.length).toBe(1);
  });

  it('reports MalformedInput for proposer.additionalContext at user tier', () => {
    const userHome = makeUserHomeWithOverlay(
      `---
schemaVersion: 1
proposer:
  additionalContext:
    - "~/checks.md"
---
`,
    );
    const result = validateAll({ projectRoot: jsTsMinimal }, { userHome });
    const forbidden = result.issues.filter(
      (i) => i.code === 'MalformedInput' && i.field === 'proposer.additionalContext',
    );
    expect(forbidden.length).toBe(1);
  });

  it('reports MalformedInput for stack.override at user tier', () => {
    const userHome = makeUserHomeWithOverlay(
      `---
schemaVersion: 1
stack:
  override:
    - web-node
---
`,
    );
    const result = validateAll({ projectRoot: jsTsMinimal }, { userHome });
    const forbidden = result.issues.filter(
      (i) => i.code === 'MalformedInput' && i.field === 'stack.override',
    );
    expect(forbidden.length).toBe(1);
  });

  it('reports MalformedInput for stack.cacheEnvOverride at user tier', () => {
    const userHome = makeUserHomeWithOverlay(
      `---
schemaVersion: 1
stack:
  cacheEnvOverride:
    web-node:
      NODE_VERSION: "20"
---
`,
    );
    const result = validateAll({ projectRoot: jsTsMinimal }, { userHome });
    const forbidden = result.issues.filter(
      (i) => i.code === 'MalformedInput' && i.field === 'stack.cacheEnvOverride',
    );
    expect(forbidden.length).toBe(1);
  });

  it('reports exactly four MalformedInput issues in deterministic order when all forbidden fields are declared', () => {
    const userHome = makeUserHomeWithOverlay(
      `---
schemaVersion: 1
planner:
  additionalContext:
    - "~/notes.md"
proposer:
  additionalContext:
    - "~/checks.md"
stack:
  override:
    - web-node
  cacheEnvOverride:
    web-node:
      NODE_VERSION: "20"
---
`,
    );
    const result = validateAll({ projectRoot: jsTsMinimal }, { userHome });
    const forbidden = result.issues.filter((i) => i.code === 'MalformedInput');
    // All four forbidden fields declared at once → exactly four issues, in a
    // fixed (not input-dependent) field order, so the report is deterministic.
    expect(forbidden.length).toBe(4);
    expect(forbidden.map((i) => i.field)).toEqual([
      'planner.additionalContext',
      'proposer.additionalContext',
      'stack.cacheEnvOverride',
      'stack.override',
    ]);
  });
});

describe('validateStack', () => {
  it('returns no issues for the clean web-node stack', () => {
    const result = validateStack({ projectRoot: jsTsMinimal, name: 'web-node' });
    expect(result.issues).toEqual([]);
  });

  it('reports SchemaMismatch on the multi-violation fixture', () => {
    const result = validateStack({ projectRoot: invalidSchemaMismatch, name: 'web-node' });
    const schemaMismatches = result.issues.filter((i) => i.code === 'SchemaMismatch');
    expect(schemaMismatches.length).toBeGreaterThanOrEqual(2);
  });

  it('reports InvalidYAML on the malformed-YAML fixture', () => {
    const result = validateStack({ projectRoot: invalidMalformedYaml, name: 'web-node' });
    const invalidYaml = findIssue(result.issues, (i) => i.code === 'InvalidYAML');
    expect(invalidYaml).toBeTruthy();
  });

  it('reports MissingFile when the named stack does not exist', () => {
    const result = validateStack({ projectRoot: jsTsMinimal, name: 'never-defined' });
    const missing = findIssue(result.issues, (i) => i.code === 'MissingFile');
    expect(missing).toBeTruthy();
    expect(missing!.message).toContain('never-defined');
  });
});

describe('validateOverlay', () => {
  it('returns no issues for the clean project overlay', () => {
    const result = validateOverlay({ projectRoot: jsTsMinimal, tier: 'project' });
    expect(result.issues).toEqual([]);
  });

  it('returns no issues when the overlay tier has no file (default tier absent)', () => {
    const result = validateOverlay({ projectRoot: jsTsMinimal, tier: 'default' });
    expect(result.issues).toEqual([]);
  });

  it('flags MissingFile on the invalid-missing-file project overlay (cross-ref check is in validateAll)', () => {
    // Scoping boundary: validateOverlay validates the overlay *in isolation*, so
    // the dangling stack reference is NOT its concern — it returns zero issues.
    // The cross-reference MissingFile check belongs to validateAll (asserted in
    // the validateAll block above).
    const result = validateOverlay({ projectRoot: invalidMissingFile, tier: 'project' });
    expect(result.issues).toEqual([]);
  });
});

describe('phase 1 discovery (smoke)', () => {
  it('finds the built-in web-node stack in js-ts-minimal', () => {
    const snapshot = _runPhase1ForTests(jsTsMinimal);
    const builtinKeys = Array.from(snapshot.stackFiles.keys()).filter((k) =>
      k.startsWith('builtin:'),
    );
    expect(builtinKeys.length).toBe(1);
    expect(builtinKeys[0]).toContain('web-node.md');
    expect(snapshot.overlays.project).not.toBeNull();
  });

  it('reports modules as the M1 no-op (empty array)', () => {
    const snapshot = _runPhase1ForTests(jsTsMinimal);
    expect(snapshot.modules).toEqual([]);
  });

  it('enumerates built-in stacks from BOTH packageRoot/stacks and projectRoot/stacks (dual fallback)', () => {
    // Place a same-named web-node stack in both the package root and the project
    // root; discovery must surface a builtin row from each location (the dual
    // fallback), so the two paths are distinct. realpathSync resolves macOS
    // /var → /private/var symlinks so the startsWith path checks below hold.
    const pkgRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'cas-validate-pkg-')));
    const projRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'cas-validate-proj-')));
    try {
      const pkgStacksDir = path.join(pkgRoot, 'stacks');
      mkdirSync(pkgStacksDir, { recursive: true });
      writeFileSync(
        path.join(pkgStacksDir, 'web-node.md'),
        ['---', 'name: web-node', 'schemaVersion: 1', '---', 'package body', ''].join('\n'),
      );
      const projStacksDir = path.join(projRoot, 'stacks');
      mkdirSync(projStacksDir, { recursive: true });
      writeFileSync(
        path.join(projStacksDir, 'web-node.md'),
        ['---', 'name: web-node', 'schemaVersion: 1', '---', 'project body', ''].join('\n'),
      );

      const snapshot = _runPhase1ForTests(projRoot, { packageRoot: pkgRoot });
      const builtinRows = Array.from(snapshot.stackFiles.entries()).filter(([k]) =>
        k.startsWith('builtin:'),
      );

      expect(builtinRows.length).toBeGreaterThanOrEqual(2);

      const lc = (s: string) => s.toLowerCase();
      const paths = builtinRows.map(([, row]) => row.path);
      const underPkg = paths.find((p) => lc(p).startsWith(lc(pkgRoot)));
      const underProj = paths.find((p) => lc(p).startsWith(lc(projRoot)));
      expect(underPkg).toBeTruthy();
      expect(underProj).toBeTruthy();
      expect(underPkg).not.toBe(underProj);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
      rmSync(projRoot, { recursive: true, force: true });
    }
  });
});

describe('MCP transport — validateAll over stdio (subprocess)', () => {
  it('responds to validateAll via tools/call with an issue list', async () => {
    const distEntry = path.join(repoRoot, 'dist', 'config-server', 'index.js');
    if (!existsSync(distEntry)) {
      // No build artefact (e.g. running unit tests before `npm run build`):
      // skip rather than fail — the in-process tests above already cover the
      // behaviour; this case only adds the transport assertion.
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
    const callRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'validateAll',
        arguments: { projectRoot: invalidSchemaMismatch },
      },
    };

    child.stdin.write(JSON.stringify(initRequest) + '\n');
    child.stdin.write(JSON.stringify(callRequest) + '\n');

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

    const callResp = responses.find(
      (
        r,
      ): r is {
        id: number;
        result: { content: Array<{ type: string; text: string }>; isError?: boolean };
      } => {
        return typeof r === 'object' && r !== null && (r as { id?: number }).id === 2;
      },
    );
    expect(callResp).toBeTruthy();
    expect(callResp!.result.isError).not.toBe(true);
    const text = callResp!.result.content[0].text;
    const payload = JSON.parse(text) as { issues: Issue[] };
    expect(Array.isArray(payload.issues)).toBe(true);

    expect(payload.issues.length).toBeGreaterThan(0);
    expect(payload.issues.some((i) => i.code === 'SchemaMismatch')).toBe(true);
  });
});
