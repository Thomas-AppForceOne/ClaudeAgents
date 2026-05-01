/**
 * R3 sprint 2 — `emitJson` unit test.
 *
 * Locks the F3 determinism contract for the CLI's single JSON emitter:
 *   - sorted keys at every depth;
 *   - two-space indent;
 *   - trailing newline;
 *   - the helper imports R1's `stableStringify` (no second sorted-key
 *     serialiser anywhere in `src/cli/`).
 *
 * The single-implementation rule is also enforced by the contract's
 * `grep` checks (`grep -rn "stableStringify" src/cli/` ≥ 1) but we
 * verify here that the helper does in fact route through that import
 * by comparing its output to the underlying primitive.
 */
import { describe, expect, it } from 'vitest';
import { emitJson } from '../../../src/cli/lib/json-output.js';
import { stableStringify } from '../../../src/config-server/determinism/index.js';

describe('emitJson', () => {
  it('produces sorted keys at every depth', () => {
    const out = emitJson({ z: 1, a: 2, m: { y: 1, x: 2 } });
    // Top level: a < m < z.
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"m"'));
    expect(out.indexOf('"m"')).toBeLessThan(out.indexOf('"z"'));
    // Nested: x < y.
    expect(out.indexOf('"x"')).toBeLessThan(out.indexOf('"y"'));
  });

  it('uses two-space indent', () => {
    const out = emitJson({ a: { b: 1 } });
    expect(out).toContain('\n  "a"');
    expect(out).toContain('\n    "b"');
  });

  it('appends a trailing newline', () => {
    expect(emitJson({})).toBe('{}\n');
    expect(emitJson([])).toBe('[]\n');
    expect(emitJson(null)).toBe('null\n');
    expect(emitJson(true)).toBe('true\n');
    expect(emitJson(42)).toBe('42\n');
    expect(emitJson('s')).toBe('"s"\n');
  });

  it('byte-identical to the underlying determinism pin (no second implementation)', () => {
    const cases: unknown[] = [
      {},
      { a: 1 },
      { z: 1, a: 2 },
      [1, 2, 3],
      { nested: { z: { y: { x: 'deep' } } } },
      { mixed: ['a', { b: 1, a: 2 }, null] },
    ];
    for (const c of cases) {
      expect(emitJson(c)).toBe(stableStringify(c));
    }
  });

  it('round-trip property: parse + emit yields byte-identical output', () => {
    const cases: unknown[] = [
      { a: 1, b: [1, 2], c: { d: 'x' } },
      { stacks: { active: ['web-node'], byName: { 'web-node': { tier: 'builtin' } } } },
      [1, 'a', null, true, false, { z: 1, a: 2 }],
    ];
    for (const c of cases) {
      const first = emitJson(c);
      const parsed = JSON.parse(first) as unknown;
      const second = emitJson(parsed);
      expect(second).toBe(first);
    }
  });
});
