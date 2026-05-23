// Verifies the A1 sprint-3 fingerprint normalization machinery: the SHA-256
// output shape and determinism, the three independently-testable normalization
// rules (whitespace rule 1, comment rule 2 + its no-op, sortable rule 3 + its
// no-op) each with a control that pins the rule does not over-collapse, and the
// prototype-pollution guard on the path-keyed map. Also exercises the stack
// schema/loader round-trip for the two new optional C1 fields: a stack
// declaring both round-trips intact, malformed values are rejected as
// SchemaMismatch, and the field-less web-node builtin stays valid.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintEditSet, type FingerprintOptions } from '../../src/safety/fingerprint.js';
import { loadStackWithValidation } from '../../src/config-server/storage/stack-loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');

// Hermetic user home: point the user tier at a directory with no stack files so
// a real ~/.claude/gan/stacks/web-node.md on the host machine cannot shadow the
// fixture-tier stack these tests resolve.
const NO_USER_HOME = { userHome: path.join(fixtureRoot, '__no_such_user_home__') };

// Fixture commentSyntax/sortableLists, mirroring the comment-sortable-fields
// stack fixture. Passed explicitly so each rule's positive case is driven by
// stack-supplied markers, never a built-in default.
const FIXTURE_OPTS: FingerprintOptions = {
  commentSyntax: { line: '//', block: { open: '/*', close: '*/' } },
  sortableLists: [{ pathGlob: '**/*.ts', lineRangePattern: '^import ' }],
};

describe('fingerprintEditSet — output shape and determinism', () => {
  it('returns a 64-char lowercase hex SHA-256 digest', () => {
    const fp = fingerprintEditSet([{ path: 'src/a.ts', content: 'const x = 1;' }]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: identical logical input yields a byte-identical digest', () => {
    const set = [
      { path: 'src/a.ts', content: 'const x = 1;' },
      { path: 'src/b.ts', content: 'const y = 2;' },
    ];
    expect(fingerprintEditSet(set)).toBe(fingerprintEditSet(set));
  });

  it('is independent of the incidental order the files are listed in', () => {
    const a = { path: 'src/a.ts', content: 'const x = 1;' };
    const b = { path: 'src/b.ts', content: 'const y = 2;' };
    expect(fingerprintEditSet([a, b])).toBe(fingerprintEditSet([b, a]));
  });
});

describe('rule 1 — whitespace-only differences collapse (no stack fields)', () => {
  it('collapses indentation / trailing-whitespace / blank-line / line-ending diffs', () => {
    const original = 'function f(){\n  return 1;\n}\n';
    const whitespaceVariant = '\r\nfunction f(){\r\n\t\treturn 1;   \r\n\r\n}\r\n';
    // commentSyntax absent + sortableLists empty: proves rule 1 is independent
    // of the stack fields.
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: original }])).toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: whitespaceVariant }]),
    );
  });

  it('control: a non-whitespace token difference does NOT collapse', () => {
    const a = fingerprintEditSet([{ path: 'src/a.ts', content: 'return 1;' }]);
    const b = fingerprintEditSet([{ path: 'src/a.ts', content: 'return 2;' }]);
    expect(a).not.toBe(b);
  });
});

describe('rule 2 — comment-only differences collapse per stack commentSyntax', () => {
  it('collapses a line-comment-only diff under the fixture commentSyntax', () => {
    const a = 'const x = 1; // first comment\n';
    const b = 'const x = 1; // a totally different comment\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it('collapses a block-comment-only diff under the fixture commentSyntax', () => {
    const a = 'const x = 1;\n/* explain x */\nconst y = 2;\n';
    const b = 'const x = 1;\n/* explain y differently */\nconst y = 2;\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it('control: a non-comment token difference does NOT collapse', () => {
    const a = 'const x = 1; // same comment\n';
    const b = 'const x = 2; // same comment\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });
});

describe('rule 2 — no-op when commentSyntax is absent', () => {
  it('a comment-only diff does NOT collapse without commentSyntax', () => {
    const a = 'const x = 1; // first comment\n';
    const b = 'const x = 1; // different comment\n';
    // No commentSyntax: the markers come from the field, so with the field
    // absent rule 2 never fires and the comment text contributes to the digest.
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }])).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }]),
    );
  });
});

describe('rule 3 — reordering within stack-declared sortableLists collapses', () => {
  it('collapses a reorder WITHIN the declared sortable region', () => {
    const a = 'import a from "a";\nimport b from "b";\nconst x = 1;\n';
    const b = 'import b from "b";\nimport a from "a";\nconst x = 1;\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it('control: reordering lines OUTSIDE the sortable region does NOT collapse', () => {
    const a = 'import a from "a";\nconst x = 1;\nconst y = 2;\n';
    const b = 'import a from "a";\nconst y = 2;\nconst x = 1;\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it("control: changing a line's content (not just order) does NOT collapse", () => {
    const a = 'import a from "a";\nimport b from "b";\n';
    const b = 'import a from "a";\nimport c from "c";\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it('control: rule 3 is scoped to the matching pathGlob only', () => {
    // Same reorder, but in a path the sortableLists glob does not match: the
    // region normalization must not apply, so the two orders differ.
    const a = 'import a from "a";\nimport b from "b";\n';
    const b = 'import b from "b";\nimport a from "a";\n';
    expect(fingerprintEditSet([{ path: 'src/a.md', content: a }], FIXTURE_OPTS)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.md', content: b }], FIXTURE_OPTS),
    );
  });
});

describe('rule 3 — no-op when sortableLists is empty', () => {
  it('a reorder that WOULD be sortable for another stack does NOT collapse', () => {
    const a = 'import a from "a";\nimport b from "b";\n';
    const b = 'import b from "b";\nimport a from "a";\n';
    // Empty sortableLists: no region is declared, so the reorder is a real
    // difference for this stack (only rule 1 applies).
    const optsNoSortable: FingerprintOptions = { commentSyntax: FIXTURE_OPTS.commentSyntax };
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], optsNoSortable)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], optsNoSortable),
    );
  });
});

describe('rule 2 — comment markers inside string literals are not stripped', () => {
  it('does NOT strip a line marker that appears inside a string literal', () => {
    // The `//` is inside the string, so it is real in-string content, not a
    // comment; two edits differing only inside the string must NOT collapse.
    // (A naive marker-strip would erase `//b"` / `//a"` and collide these.)
    const a = 'const url = "http://example.com/a";\n';
    const b = 'const url = "http://example.com/b";\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it('does NOT strip a block-open marker that appears inside a string literal', () => {
    const a = 'const s = "/* literal a */";\n';
    const b = 'const s = "/* literal b */";\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it('still strips a real comment while preserving an adjacent string with an in-string marker', () => {
    // The string content (with its in-string `//`) is identical and preserved;
    // only the trailing real comment differs, so the two collapse — the fix
    // narrows stripping to real comments, it does not stop stripping them.
    const a = 'const url = "http://x"; // note one\n';
    const b = 'const url = "http://x"; // note two\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });

  it('an escaped quote does not end the string early', () => {
    // The \" is an escaped quote inside the string, so the string does not
    // close there and the following `//` is still in-string content; a and b
    // differ only inside that string, so they must NOT collapse.
    const a = 'const s = "a\\"// x";\n';
    const b = 'const s = "a\\"// y";\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).not.toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });
});

describe('rule 3 — reorder collapses even with differing in-region whitespace', () => {
  it('collapses a reorder WITHIN the region despite incidental in-region whitespace diffs', () => {
    // Same imports, reordered AND with differing internal whitespace. Rule 1
    // (per-line whitespace collapse) runs before the rule-3 sort, so the sort
    // key is whitespace-normalized and the two still collapse — guarding the
    // false negative where a reorder plus incidental whitespace would not.
    const a = 'import a from "a";\nimport   b   from "b";\nconst x = 1;\n';
    const b = 'import b from "b";\nimport a from   "a";\nconst x = 1;\n';
    expect(fingerprintEditSet([{ path: 'src/a.ts', content: a }], FIXTURE_OPTS)).toBe(
      fingerprintEditSet([{ path: 'src/a.ts', content: b }], FIXTURE_OPTS),
    );
  });
});

describe('fingerprintEditSet — prototype-pollution resistance', () => {
  it('does not pollute Object.prototype and does not crash on a __proto__ path', () => {
    const before = ({} as Record<string, unknown>).polluted;
    const fp = fingerprintEditSet([
      { path: '__proto__', content: 'const a = 1;' },
      { path: 'constructor', content: 'const b = 2;' },
      { path: 'prototype', content: 'const c = 3;' },
      { path: 'src/ok.ts', content: 'const d = 4;' },
    ]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // Object.prototype must be untouched.
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('does not silently drop forbidden-key path content from the digest', () => {
    // Two edit sets that differ only in the content under a __proto__ path must
    // produce different digests — a guard that dropped the key would collide.
    const a = fingerprintEditSet([{ path: '__proto__', content: 'const a = 1;' }]);
    const b = fingerprintEditSet([{ path: '__proto__', content: 'const a = 2;' }]);
    expect(a).not.toBe(b);
  });

  it('tolerates a forbidden-key pathGlob in sortableLists without crashing', () => {
    const opts: FingerprintOptions = {
      sortableLists: [{ pathGlob: '__proto__', lineRangePattern: '^import ' }],
    };
    const fp = fingerprintEditSet([{ path: 'src/a.ts', content: 'const x = 1;' }], opts);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stack schema/loader round-trip for the new C1 fields', () => {
  it('a stack declaring commentSyntax and sortableLists validates clean and round-trips', () => {
    const { loaded, issues } = loadStackWithValidation(
      'web-node',
      path.join(fixtureRoot, 'comment-sortable-fields'),
      NO_USER_HOME,
    );
    expect(issues).toEqual([]);
    expect(loaded).not.toBeNull();
    const data = loaded!.data as Record<string, unknown>;

    const commentSyntax = data.commentSyntax as {
      line?: string;
      block?: { open: string; close: string };
    };
    expect(commentSyntax.line).toBe('//');
    expect(commentSyntax.block).toEqual({ open: '/*', close: '*/' });

    const sortableLists = data.sortableLists as Array<{
      pathGlob: string;
      lineRangePattern: string;
    }>;
    expect(sortableLists).toEqual([{ pathGlob: '**/*.ts', lineRangePattern: '^import ' }]);
  });

  it('rejects a sortableLists item missing pathGlob as a SchemaMismatch', () => {
    const { issues } = loadStackWithValidation(
      'web-node',
      path.join(fixtureRoot, 'malformed-sortable-list'),
      NO_USER_HOME,
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('rejects a commentSyntax.block missing close as a SchemaMismatch', () => {
    const { issues } = loadStackWithValidation(
      'web-node',
      path.join(fixtureRoot, 'malformed-comment-syntax'),
      NO_USER_HOME,
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'SchemaMismatch')).toBe(true);
  });

  it('the field-less web-node builtin stays valid (fields are optional/additive)', () => {
    // The shipped web-node stack declares NEITHER field; the schema additions
    // are optional, so it must continue to validate with zero issues, and the
    // absent fields mean rules 2 and 3 are no-ops for it.
    const { loaded, issues } = loadStackWithValidation('web-node', repoRoot, NO_USER_HOME);
    expect(issues).toEqual([]);
    expect(loaded).not.toBeNull();
    const data = loaded!.data as Record<string, unknown>;
    expect(data.commentSyntax).toBeUndefined();
    expect(data.sortableLists).toBeUndefined();
  });
});
