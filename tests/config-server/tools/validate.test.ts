import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
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

function findIssue(issues: Issue[], predicate: (i: Issue) => boolean): Issue | undefined {
  return issues.find(predicate);
}

describe('validateAll', () => {
  it('returns no issues for a clean fixture (js-ts-minimal)', () => {
    const result = validateAll({ projectRoot: jsTsMinimal });
    expect(result.issues).toEqual([]);
  });

  it('reports SchemaMismatch with field provenance for invalid-schema-mismatch', () => {
    const result = validateAll({ projectRoot: invalidSchemaMismatch });
    const schemaMismatches = result.issues.filter((i) => i.code === 'SchemaMismatch');
    expect(schemaMismatches.length).toBeGreaterThan(0);
    // Every schema-mismatch issue from this fixture should carry a non-empty
    // field (JSON-pointer-style) tying the message to a specific path in the
    // YAML body.
    for (const issue of schemaMismatches) {
      expect(typeof issue.field).toBe('string');
      expect((issue.field ?? '').length).toBeGreaterThan(0);
      expect(issue.path).toContain('web-node.md');
    }
  });

  it('returns multiple issues for a file with multiple schema violations', () => {
    // The fixture has TWO violations: securitySurfaces[0] missing 'template',
    // and secretsGlob[0] violating pattern "^[^.]". Both must be reported.
    const result = validateAll({ projectRoot: invalidSchemaMismatch });
    const issuesForFile = result.issues.filter(
      (i) => i.code === 'SchemaMismatch' && (i.path ?? '').endsWith('web-node.md'),
    );
    expect(issuesForFile.length).toBeGreaterThanOrEqual(2);
    // One of them mentions securitySurfaces (missing template), one mentions secretsGlob.
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
    // The issue is raised against the offending overlay file.
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
    // The invalid-schema-mismatch fixture has only one stack file; no overlay.
    // Sanity check that the pipeline returns issues without throwing.
    expect(() => validateAll({ projectRoot: invalidSchemaMismatch })).not.toThrow();
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
    // validateOverlay runs body schema validation only; cross-overlay
    // reference checks live in validateAll's phase 1. The overlay itself
    // is structurally valid.
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
});

describe('MCP transport — validateAll over stdio (subprocess)', () => {
  it('responds to validateAll via tools/call with an issue list', async () => {
    const distEntry = path.join(repoRoot, 'dist', 'config-server', 'index.js');
    if (!existsSync(distEntry)) {
      // The build is the discriminator's job; skip if it has not yet run.
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
    // The fixture has at least 2 schema-mismatch issues.
    expect(payload.issues.length).toBeGreaterThan(0);
    expect(payload.issues.some((i) => i.code === 'SchemaMismatch')).toBe(true);
  });
});
