/**
 * Semantic-gate coverage for the three E8 fixture manifests under
 * `tests/fixtures/e8/`.
 *
 * The sibling `manifest-validation.test.ts` is deliberately scoped to JSON
 * shape (count entries / check enums) and explicitly does not open the cited
 * source files, execute any `reproductionCommand`, or compare planted-defect
 * code against the manifest's prose. That left three fixture-vs-reality
 * contracts unguarded — each one a class of drift that quietly weakens the
 * discriminator-quality benchmark:
 *
 *   (1) Polarity drift — a `kind: "command"` finding's reproductionCommand
 *       must exit 0 when the defect IS present (the orchestrator's gate
 *       `validateFindings` keeps on `exitCode === 0` and drops otherwise,
 *       per `src/agents/independent-review/finding-validation.ts:108-114`).
 *       A fixture authored against the UNIX `exit 1 = failing test` idiom
 *       drops the correct finding and the fixture's whole purpose inverts.
 *   (2) Evidence-pointer drift — a `kind: "inspection"` decoy's
 *       `evidencePointer` must land on a line that contains the construct
 *       the faked finding claims to cite (so the contract-reviewer's
 *       well-foundedness audit rejects the finding for the spec-targeted
 *       reason — "the cited line uses the safe form" — rather than for the
 *       wrong reason — "the cited line is not the named construct at all").
 *   (3) Code-vs-description drift — a planted defect's `defect.ts` must
 *       actually realise the bug the manifest's prose describes; otherwise
 *       a reviewer who correctly describes the code's real defect is
 *       scored wrong by the discriminator benchmark.
 *
 * This file pins all three. Failures here surface the specific fixture id
 * and the specific reality the manifest drifted away from.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

interface PlantedDefectManifestEntry {
  readonly id: string;
  readonly class: string;
  readonly severity: string;
  readonly kind: 'command' | 'inspection';
  readonly description: string;
  readonly expected_catch_behaviour: string;
}

interface DecoyManifestEntry {
  readonly id: string;
  readonly kind: 'command' | 'inspection';
  readonly expectedDropOrReject: 'drop-at-reproduction-gate' | 'reject-at-well-foundedness-audit';
  readonly rationale: string;
  readonly fakedFindingPayload: {
    readonly id: string;
    readonly class: string;
    readonly severity: string;
    readonly kind: 'command' | 'inspection';
    readonly summary: string;
    readonly reproductionCommand?: string;
    readonly evidencePointer?: string;
  };
}

interface ExpectedReviewerFinding {
  readonly id: string;
  readonly class: string;
  readonly severity: string;
  readonly kind: 'command' | 'inspection';
  readonly summary: string;
  readonly reproductionCommand?: string;
  readonly evidencePointer?: string;
}

/** Parse a JSON file relative to {@link THIS_DIR}. */
function loadJson<T>(relPath: string): T {
  const abs = path.join(THIS_DIR, relPath);
  return JSON.parse(readFileSync(abs, 'utf8')) as T;
}

function readFixtureFile(relPath: string): string {
  return readFileSync(path.join(THIS_DIR, relPath), 'utf8');
}

/**
 * Per-decoy construct-token lookup. For an inspection decoy whose
 * evidencePointer is `source.ts:N`, the cited line MUST contain the listed
 * token — proving the manifest's pointer actually lands on the construct the
 * decoy means to dangle in front of the well-foundedness audit. A new
 * inspection decoy without an entry here is itself a test failure (forces the
 * author to register the expected construct, so a pointer-vs-construct drift
 * cannot ship silently).
 */
const DECOY_INSPECTION_CONSTRUCT_TOKENS: Readonly<Record<string, RegExp>> = {
  'inspection-claims-empty-catch-actually-rethrows': /\bcatch\b/,
  'inspection-claims-shell-injection-actually-spawn-array': /\bspawn\b/,
};

/**
 * Per-planted-defect on-disk shape matchers. Only the fixtures whose code
 * shape is the load-bearing part of the manifest's claim are checked here:
 *
 * - `correctness-off-by-one`: the off-by-one is the `<=` in the loop bound;
 *   the manifest description says "loop bound is `<=` where it should be
 *   `<`", so the on-disk code MUST carry that `<=` token in an iteration
 *   condition referencing `arr.length`.
 * - `concurrency-lock-across-await`: the manifest says "acquires a flag,
 *   awaits, releases in a `finally`", which is the classic lock-across-await
 *   shape. The flag MUST be set to `true` BEFORE the `await sideEffect()` —
 *   any reordering collapses the bug into the unrelated "dead-flag" defect
 *   the original code accidentally encoded.
 *
 * Pragmatic per-fixture regexes — the goal is to catch drift, not to be an
 * exhaustively schema-driven AST matcher. Adding a new planted defect with a
 * shape-critical claim should add a matcher here; defects whose claim is
 * purely about a single line's contents are already covered by the
 * evidencePointer/construct-token loop above.
 */
const PLANTED_DEFECT_CODE_MATCHERS: Readonly<
  Record<string, ReadonlyArray<{ readonly name: string; readonly regex: RegExp }>>
> = {
  'correctness-off-by-one': [
    {
      name: 'loop bound is `i <= arr.length` (the off-by-one)',
      regex: /for\s*\([^)]*;\s*[a-zA-Z_$][\w$]*\s*<=\s*[a-zA-Z_$][\w$]*\.length\s*;[^)]*\)/,
    },
  ],
  'concurrency-lock-across-await': [
    {
      name: '`inFlight = true` set BEFORE `await sideEffect()`',
      // The defect file MUST contain the synchronous flag-set on a line that
      // appears strictly above the `await sideEffect()` line. We assert by
      // matching a substring that captures the order: ... `inFlight = true`
      // ... followed (with any whitespace/newlines) by ... `await
      // sideEffect()` ... — the dot-all flag lets `.` cross newlines.
      regex: /inFlight\s*=\s*true[\s\S]*?await\s+sideEffect\s*\(\s*\)/,
    },
  ],
};

const PLANTED_DEFECTS_DIR = 'planted-defects';
const DECOYS_DIR = 'decoys';

/**
 * Parse an `evidencePointer` of the form `<file>:<line>` into its parts.
 * Returns `null` if the string does not match the expected shape — the
 * caller's assertion then surfaces the malformed pointer.
 */
function parsePointer(pointer: string): { file: string; line: number } | null {
  const match = pointer.match(/^(.+):(\d+)$/);
  if (!match) return null;
  return { file: match[1] ?? '', line: Number(match[2]) };
}

describe('E8 planted-defect command-kind reproductionCommand polarity', () => {
  const manifest = loadJson<readonly PlantedDefectManifestEntry[]>(
    `${PLANTED_DEFECTS_DIR}/manifest.json`,
  );
  const commandEntries = manifest.filter((e) => e.kind === 'command');

  // Every planted-defect kind:"command" fixture must reproduce its bug
  // (exit 0 IFF the defect is present). The orchestrator's gate keeps on
  // exit 0; a fixture that exits non-zero would have its correct finding
  // silently dropped by the gate, breaking the discriminator-quality
  // benchmark this fixture suite anchors.
  for (const entry of commandEntries) {
    it(`${entry.id}: reproductionCommand exits 0 (gate keeps the finding)`, () => {
      const findingPath = `${PLANTED_DEFECTS_DIR}/${entry.id}/expected-reviewer-finding.json`;
      const finding = loadJson<ExpectedReviewerFinding>(findingPath);
      expect(finding.reproductionCommand, `${entry.id}: expected reproductionCommand on finding`)
        .toBeDefined();
      const cmd = finding.reproductionCommand as string;
      const fixtureDir = path.join(THIS_DIR, PLANTED_DEFECTS_DIR, entry.id);
      // The schema currently allows shell strings, so we spawn through
      // `/bin/sh` — same shell the orchestrator's `Bash` tool would invoke.
      // Per the gate's convention, exit 0 means "defect demonstrated; keep".
      const result = spawnSync(cmd, { cwd: fixtureDir, shell: '/bin/sh', encoding: 'utf8' });
      expect(
        result.status,
        `${entry.id}: exit 0 = defect demonstrated (kept by gate). stderr:\n${result.stderr ?? ''}`,
      ).toBe(0);
    });
  }
});

describe('E8 decoy command-kind reproductionCommand polarity', () => {
  const manifest = loadJson<readonly DecoyManifestEntry[]>(`${DECOYS_DIR}/manifest.json`);
  const dropDecoys = manifest.filter(
    (d) => d.kind === 'command' && d.expectedDropOrReject === 'drop-at-reproduction-gate',
  );

  // Every decoy whose intended outcome is "drop-at-reproduction-gate" MUST
  // exit non-zero — otherwise the orchestrator's gate would KEEP it (gate
  // keeps on exit 0) and the decoy would silently fail to exercise the
  // drop-path it exists to test.
  for (const decoy of dropDecoys) {
    it(`${decoy.id}: reproductionCommand exits non-zero (gate drops the finding)`, () => {
      const cmd = decoy.fakedFindingPayload.reproductionCommand;
      expect(cmd, `${decoy.id}: expected reproductionCommand on fakedFindingPayload`).toBeDefined();
      // command-grep-missing-string uses a repo-root-relative path so the
      // cwd is the repo root; everything else runs from the decoy's own
      // directory so `./source.ts`-style imports resolve.
      const repoRoot = path.resolve(THIS_DIR, '..', '..', '..');
      const useRepoRoot = (cmd as string).includes('tests/fixtures/');
      const cwd = useRepoRoot ? repoRoot : path.join(THIS_DIR, DECOYS_DIR, decoy.id);
      const result = spawnSync(cmd as string, { cwd, shell: '/bin/sh', encoding: 'utf8' });
      expect(
        result.status,
        `${decoy.id}: non-zero exit = defect NOT demonstrated (dropped by gate). stderr:\n${result.stderr ?? ''}`,
      ).not.toBe(0);
    });
  }
});

describe('E8 decoy inspection-kind evidencePointer cites a real construct line', () => {
  const manifest = loadJson<readonly DecoyManifestEntry[]>(`${DECOYS_DIR}/manifest.json`);
  const inspectionDecoys = manifest.filter((d) => d.kind === 'inspection');

  // Every inspection decoy's evidencePointer MUST resolve to a real
  // file:line, and that line MUST contain the construct token the
  // well-foundedness audit is meant to inspect. Otherwise the audit rejects
  // for the wrong reason ("the cited line is a comment / function
  // declaration / blank") and the decoy fails to exercise the safe-form
  // discrimination it exists to test.
  for (const decoy of inspectionDecoys) {
    it(`${decoy.id}: evidencePointer line contains the expected construct token`, () => {
      const pointer = decoy.fakedFindingPayload.evidencePointer;
      expect(pointer, `${decoy.id}: expected evidencePointer on fakedFindingPayload`).toBeDefined();
      const parsed = parsePointer(pointer as string);
      expect(parsed, `${decoy.id}: evidencePointer must be of the form "<file>:<line>"`)
        .not.toBeNull();
      const { file, line } = parsed as { file: string; line: number };
      const fileText = readFixtureFile(path.join(DECOYS_DIR, decoy.id, file));
      const lines = fileText.split(/\r?\n/);
      // Pointers are 1-indexed; `lines` is 0-indexed.
      expect(line, `${decoy.id}: evidencePointer line must be in range for ${file}`).toBeGreaterThan(0);
      expect(line, `${decoy.id}: evidencePointer line ${line} exceeds ${file} length ${lines.length}`)
        .toBeLessThanOrEqual(lines.length);
      const cited = lines[line - 1] ?? '';
      const expectedToken = DECOY_INSPECTION_CONSTRUCT_TOKENS[decoy.id];
      expect(
        expectedToken,
        `${decoy.id}: register the expected construct token in DECOY_INSPECTION_CONSTRUCT_TOKENS`,
      ).toBeDefined();
      expect(
        cited,
        `${decoy.id}: cited line ${line} of ${file} (${JSON.stringify(cited)}) must match ${String(
          expectedToken,
        )}`,
      ).toMatch(expectedToken as RegExp);
    });
  }
});

describe('E8 planted-defect on-disk code matches the manifest description', () => {
  // For the fixtures whose load-bearing claim is a structural property of
  // the code (loop bound, statement ordering), assert the on-disk shape
  // matches the matchers above. A defect file edited away from its intended
  // shape (the I-013 root cause) surfaces here as a named-fixture failure.
  for (const [defectId, matchers] of Object.entries(PLANTED_DEFECT_CODE_MATCHERS)) {
    it(`${defectId}: defect.ts realises the manifest's described shape`, () => {
      const defectText = readFixtureFile(`${PLANTED_DEFECTS_DIR}/${defectId}/defect.ts`);
      for (const m of matchers) {
        expect(
          defectText,
          `${defectId}: defect.ts must contain ${m.name} (regex: ${String(m.regex)})`,
        ).toMatch(m.regex);
      }
    });
  }
});
