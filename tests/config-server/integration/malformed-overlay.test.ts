
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../../src/config-server/tools/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

describe('integration: malformed overlays + stacks (error path)', () => {
  it('reports SchemaMismatch with file path + field provenance for invalid-schema-mismatch', () => {
    const projectRoot = path.join(fixturesRoot, 'invalid-schema-mismatch');
    const result = validateAll({ projectRoot });
    const schemaIssues = result.issues.filter((i) => i.code === 'SchemaMismatch');
    expect(schemaIssues.length).toBeGreaterThanOrEqual(2);
    for (const issue of schemaIssues) {

      expect(typeof issue.path).toBe('string');
      expect(issue.path).toContain('web-node.md');

      expect(typeof issue.field).toBe('string');
      expect((issue.field ?? '').length).toBeGreaterThan(0);
    }
  });

  it('reports InvalidYAML with file path for invalid-malformed-yaml', () => {
    const projectRoot = path.join(fixturesRoot, 'invalid-malformed-yaml');
    const result = validateAll({ projectRoot });
    const invalid = result.issues.find((i) => i.code === 'InvalidYAML');
    expect(invalid).toBeTruthy();
    expect(invalid!.path).toContain('web-node.md');
    expect(invalid!.message.length).toBeGreaterThan(0);

    expect(invalid!.message.toLowerCase()).not.toContain('ajv');
  });

  it('reports MissingFile with file path + /stack/override field for invalid-missing-file', () => {
    const projectRoot = path.join(fixturesRoot, 'invalid-missing-file');
    const result = validateAll({ projectRoot });
    const missing = result.issues.find((i) => i.code === 'MissingFile');
    expect(missing).toBeTruthy();
    expect(missing!.path).toContain('project.md');
    expect(missing!.field).toBe('/stack/override');
    expect(missing!.message.length).toBeGreaterThan(0);
  });
});
