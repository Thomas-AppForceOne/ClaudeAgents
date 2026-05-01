/**
 * R1 sprint 7 integration test — error-path acceptance.
 *
 * `validateAll` against the malformed fixtures must surface exactly the
 * expected error class with file path and field provenance. The test
 * exercises three of the four R1 error classes the F2 contract enumerates
 * for malformed input:
 *
 *   - `SchemaMismatch` for the `invalid-schema-mismatch` fixture (two
 *     simultaneous schema violations on a single file; both must be
 *     reported, neither short-circuited).
 *   - `InvalidYAML` for the `invalid-malformed-yaml` fixture (unclosed
 *     bracket in the YAML body).
 *   - `MissingFile` for the `invalid-missing-file` fixture (project
 *     overlay's `stack.override` names a non-existent stack).
 */
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
      // Path provenance: every SchemaMismatch issue points at a file.
      expect(typeof issue.path).toBe('string');
      expect(issue.path).toContain('web-node.md');
      // Field provenance: every SchemaMismatch carries a JSON-pointer-
      // style field reference (e.g. /securitySurfaces/0).
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
    // F4 user-facing-text discipline: the message refers to the file
    // path, not "ajv" or "the validator".
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
