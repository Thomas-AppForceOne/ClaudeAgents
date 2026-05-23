// Tests for `emitJson`, the CLI's `--json` serializer. The contract: byte-for-
// byte deterministic output (recursively sorted keys, two-space indent, a single
// trailing newline) so machine consumers and golden-file comparisons are stable.
// The load-bearing test is the byte-identity check against `stableStringify`:
// `emitJson` must *be* the determinism pin, not a second JSON formatter that
// could drift from it.

import { describe, expect, it } from 'vitest';
import { emitJson } from '../../../src/cli/lib/json-output.js';
import { stableStringify } from '../../../src/config-server/determinism/index.js';

describe('emitJson', () => {
  it('produces sorted keys at every depth', () => {
    const out = emitJson({ z: 1, a: 2, m: { y: 1, x: 2 } });

    // Assert ordering by substring position rather than re-parsing: the point is
    // the literal text order, which is what a machine consumer diffs against.
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"m"'));
    expect(out.indexOf('"m"')).toBeLessThan(out.indexOf('"z"'));

    // Nested keys are sorted too, not just the top level.
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
