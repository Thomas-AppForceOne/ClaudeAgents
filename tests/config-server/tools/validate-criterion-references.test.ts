/**
 * Vitest suite for the contract-proposer pre-flight name-resolution surface.
 *
 * Coverage:
 *  - The pure-function backbone at `src/config-server/resolution/criterion-references.ts`:
 *    fixture-driven cases for the all-resolved / fabricated-script /
 *    non-`npm run` shapes the introducing spec pins.
 *  - The MCP tool wrapper at `src/config-server/tools/validate-criterion-references.ts`:
 *    end-to-end against a synthesised git worktree, verifying the `git show
 *    <baseRef>:package.json` read flows into the same record shape the
 *    backbone produces against the same script map. Also pins the
 *    `MalformedInput` refusal on an empty `baseRef` and the documented
 *    fallback-to-empty-scripts behaviour when `git show` fails.
 *
 * The fixtures under `tests/fixtures/criterion-references/` mirror the
 * three deliverable shapes the introducing spec names: an all-resolved
 * contract, a contract with a fabricated script (plus a close-match
 * `house-rules` so the hint candidate is exercised), and a contract
 * carrying non-`npm run` backtick tokens that must be ignored.
 *
 * The wrapper test creates a real, ephemeral git repository, commits a
 * `package.json` fixture, and uses the worktree path as the `cwd` argument
 * — so the subprocess-safety claim (`execFile` argv form, no shell
 * interpolation) is exercised against a real `git show` invocation rather
 * than mocked.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateCriterionReferences as resolverValidateCriterionReferences,
  type ContractDraftLike,
} from '../../../src/config-server/resolution/criterion-references.js';
import { validateCriterionReferencesTool } from '../../../src/config-server/tools/validate-criterion-references.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'criterion-references');
const packageJsonPath = path.join(fixtureDir, 'package-with-real-scripts.json');

/**
 * Load a fixture JSON file as a `ContractDraftLike`. Throws on parse failure
 * so a mis-shaped fixture surfaces at test load time rather than mid-test.
 */
function loadFixture(fileName: string): ContractDraftLike {
  const text = readFileSync(path.join(fixtureDir, fileName), 'utf8');
  return JSON.parse(text) as ContractDraftLike;
}

describe('criterion-references — pure-function backbone', () => {
  const packageJsonContents = readFileSync(packageJsonPath, 'utf8');

  it('all-resolved contract: every record carries resolved: true', () => {
    const draft = loadFixture('contract-all-resolved.json');
    const result = resolverValidateCriterionReferences({
      draft,
      packageJsonContents,
    });
    expect(result.records).toHaveLength(3);
    expect(result.unresolvedCount).toBe(0);
    for (const record of result.records) {
      expect(record.kind).toBe('npmScript');
      expect(record.resolved).toBe(true);
      expect(record.hint).toBeUndefined();
    }
    // Spot-check name and criterionName routing on the first record.
    expect(result.records[0]!.name).toBe('house-rules');
    expect(result.records[0]!.criterionName).toBe('house_rules_passes');
  });

  it('fabricated-script contract: unresolved records carry resolved: false and a hint when a close match exists', () => {
    const draft = loadFixture('contract-with-fabricated.json');
    const result = resolverValidateCriterionReferences({
      draft,
      packageJsonContents,
    });
    expect(result.records).toHaveLength(3);
    expect(result.unresolvedCount).toBe(2);

    // The first fabricated reference is `test-house-rules`; the real script
    // is `house-rules`. Levenshtein distance is 5, OUTSIDE the hint ceiling
    // of 3 — so no hint surfaces (the conservative-hint contract is the
    // documented behaviour; surfacing `house-rules` at distance 5 would be
    // a wrong proposal, not a useful one).
    const fabricated = result.records[0]!;
    expect(fabricated.name).toBe('test-house-rules');
    expect(fabricated.resolved).toBe(false);
    expect(fabricated.hint).toBeUndefined();
    expect(fabricated.source).toContain('npm run test-house-rules');
    expect(fabricated.criterionName).toBe('fabricated_house_rules_alias');

    // The second fabricated reference is `frobnicate-the-widgets`; no
    // candidate is within distance 3 — so no hint surfaces.
    const farAway = result.records[1]!;
    expect(farAway.name).toBe('frobnicate-the-widgets');
    expect(farAway.resolved).toBe(false);
    expect(farAway.hint).toBeUndefined();

    // The silent-flag form normalises to `house-rules` and resolves.
    const silent = result.records[2]!;
    expect(silent.name).toBe('house-rules');
    expect(silent.resolved).toBe(true);
    expect(silent.source).toContain('npm run -s house-rules');
  });

  it('close-typo hint: a fabricated single-character typo surfaces the closest real script', () => {
    // Constructed in-test rather than as a fixture file because the spec's
    // hint contract is the load-bearing behaviour and the input is small.
    // `houserules` is distance 1 from the real `house-rules` (one inserted
    // `-`); the hint must surface.
    const draft: ContractDraftLike = {
      criteria: [
        {
          name: 'close_typo',
          description: 'Running `npm run houserules` from the worktree exits 0.',
          threshold: 9,
        },
      ],
    };
    const result = resolverValidateCriterionReferences({
      draft,
      packageJsonContents,
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.resolved).toBe(false);
    expect(result.records[0]!.hint).toBe('house-rules');
  });

  it('non-`npm run` backtick tokens are ignored (paths, symbol names, bare commands)', () => {
    const draft = loadFixture('contract-with-non-npm-tokens.json');
    const result = resolverValidateCriterionReferences({
      draft,
      packageJsonContents,
    });
    expect(result.records).toHaveLength(0);
    expect(result.unresolvedCount).toBe(0);
  });

  it('malformed package.json collapses to "no scripts" and surfaces every reference as unresolved', () => {
    // Documented failure mode: a non-JSON blob does NOT throw — the resolver
    // treats it as an empty script map. The proposer sees every reference as
    // unresolved and can act on the noisy-but-bounded report.
    const draft = loadFixture('contract-all-resolved.json');
    const result = resolverValidateCriterionReferences({
      draft,
      packageJsonContents: 'this is not json',
    });
    expect(result.records).toHaveLength(3);
    expect(result.unresolvedCount).toBe(3);
    for (const record of result.records) {
      expect(record.resolved).toBe(false);
    }
  });

  it('a draft missing the criteria array yields an empty record array', () => {
    const result = resolverValidateCriterionReferences({
      draft: { criteria: [] },
      packageJsonContents,
    });
    expect(result.records).toEqual([]);
    expect(result.unresolvedCount).toBe(0);
  });
});

describe('criterion-references — MCP tool wrapper', () => {
  it('reads package.json from the supplied baseRef and resolves against its script map', () => {
    // Stand up an ephemeral git repo so the wrapper's `git show <baseRef>:package.json`
    // read exercises real subprocess plumbing rather than a mock. The fixture
    // package.json is the same one the backbone tests use, so the resolution
    // result must match the backbone's result on the same script map.
    const tmp = mkdtempSync(path.join(tmpdir(), 'criterion-refs-wrapper-'));
    try {
      execFileSync('git', ['-C', tmp, 'init', '-q', '-b', 'main']);
      execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test']);
      copyFileSync(packageJsonPath, path.join(tmp, 'package.json'));
      execFileSync('git', ['-C', tmp, 'add', 'package.json']);
      execFileSync('git', ['-C', tmp, 'commit', '-q', '-m', 'add package.json']);

      const draft = JSON.parse(
        readFileSync(path.join(fixtureDir, 'contract-with-fabricated.json'), 'utf8'),
      ) as ContractDraftLike;

      const result = validateCriterionReferencesTool({
        contractDraft: draft,
        baseRef: 'HEAD',
        cwd: tmp,
      });
      expect(result.unresolvedCount).toBe(2);
      expect(result.records).toHaveLength(3);
      expect(result.records[0]!.name).toBe('test-house-rules');
      expect(result.records[2]!.name).toBe('house-rules');
      expect(result.records[2]!.resolved).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses an empty baseRef with MalformedInput before invoking git', () => {
    expect(() =>
      validateCriterionReferencesTool({
        contractDraft: { criteria: [] },
        baseRef: '',
      }),
    ).toThrow(/baseRef/);
  });

  it('falls back to "no scripts" when git show fails (no repo, no package.json, etc.)', () => {
    // A directory that is not a git repo causes `git show` to exit non-zero;
    // the wrapper documented behaviour is to treat the failure as "no
    // scripts defined" rather than throwing, so every recognised reference
    // surfaces as unresolved. The fallback is the diagnostic the proposer
    // acts on.
    const tmp = mkdtempSync(path.join(tmpdir(), 'criterion-refs-norepo-'));
    try {
      const draft = JSON.parse(
        readFileSync(path.join(fixtureDir, 'contract-all-resolved.json'), 'utf8'),
      ) as ContractDraftLike;
      const result = validateCriterionReferencesTool({
        contractDraft: draft,
        baseRef: 'HEAD',
        cwd: tmp,
      });
      expect(result.unresolvedCount).toBe(3);
      for (const record of result.records) {
        expect(record.resolved).toBe(false);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT shell-interpolate the baseRef — a metacharacter-bearing ref is passed as one argv element', () => {
    // The wrapper invokes `git show` via execFile with the baseRef as one
    // argv element. A ref containing `;` cannot escape the argument
    // boundary because there is no shell to interpret it; `git` itself
    // rejects the malformed ref (returning a non-zero exit code), and the
    // wrapper's documented fallback kicks in. This test pins the
    // "subprocess safety" claim: the call returns the documented
    // no-scripts result rather than executing a shell side effect.
    const tmp = mkdtempSync(path.join(tmpdir(), 'criterion-refs-safe-'));
    try {
      execFileSync('git', ['-C', tmp, 'init', '-q', '-b', 'main']);
      execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test']);
      copyFileSync(packageJsonPath, path.join(tmp, 'package.json'));
      execFileSync('git', ['-C', tmp, 'add', 'package.json']);
      execFileSync('git', ['-C', tmp, 'commit', '-q', '-m', 'add package.json']);
      writeFileSync(path.join(tmp, 'side-effect-marker.txt'), 'pristine');

      const draft = JSON.parse(
        readFileSync(path.join(fixtureDir, 'contract-all-resolved.json'), 'utf8'),
      ) as ContractDraftLike;

      // The ref is well-formed up to the colon — but the wrapper passes the
      // full `${baseRef}:package.json` string as ONE argv element, so a
      // semicolon inside `baseRef` is rejected by `git show` rather than
      // interpreted by a shell. The wrapper falls back to the no-scripts
      // path, and the side-effect-marker.txt file is unchanged.
      const result = validateCriterionReferencesTool({
        contractDraft: draft,
        baseRef: 'HEAD; echo INJECTED > side-effect-marker.txt',
        cwd: tmp,
      });
      expect(result.unresolvedCount).toBe(3);
      const marker = readFileSync(path.join(tmp, 'side-effect-marker.txt'), 'utf8');
      expect(marker).toBe('pristine');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
