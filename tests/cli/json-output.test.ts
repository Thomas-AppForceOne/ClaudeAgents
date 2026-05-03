/**
 * R3 sprint 2 — F3 determinism end-to-end.
 *
 * Every `--json` output goes through `emitJson` (sorted keys, two-space
 * indent, trailing newline). This test runs each S2 read subcommand 100
 * times and verifies the byte-identical round-trip property:
 *
 *   stdout_n === stdout_0  for n in [1..99]
 *   JSON.parse(stdout) re-encoded via emitJson === stdout
 *
 * 100 invocations per subcommand catches any hidden non-determinism
 * (timestamps, Set iteration order, Object.keys race, etc.) that a
 * single comparison might miss. We use `Promise.all` with a chunked
 * concurrency cap so the test stays fast on dev laptops.
 */
import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';
import { emitJson } from '../../src/cli/lib/json-output.js';

const FIXTURE_MIN = stackFixturePath('js-ts-minimal');
const FIXTURE_POLYGLOT = stackFixturePath('polyglot-webnode-synthetic');

const CASES: Array<{ name: string; argv: string[]; runs: number }> = [
  {
    name: 'config print',
    argv: ['config', 'print', '--project-root', FIXTURE_MIN, '--json'],
    runs: 100,
  },
  {
    name: 'stacks list (polyglot)',
    argv: ['stacks', 'list', '--project-root', FIXTURE_POLYGLOT, '--json'],
    runs: 100,
  },
  {
    name: 'stacks list (empty)',
    argv: ['stacks', 'list', '--project-root', FIXTURE_MIN, '--json'],
    runs: 100,
  },
  {
    name: 'stack show web-node',
    argv: ['stack', 'show', 'web-node', '--project-root', FIXTURE_MIN, '--json'],
    runs: 100,
  },
  {
    name: 'modules list',
    argv: ['modules', 'list', '--project-root', FIXTURE_MIN, '--json'],
    runs: 100,
  },
];

async function runChunked<T>(
  items: T[],
  cap: number,
  fn: (t: T) => Promise<unknown>,
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < cap; i += 1) {
    workers.push(
      (async () => {
        let next = queue.shift();
        while (next !== undefined) {
          await fn(next);
          next = queue.shift();
        }
      })(),
    );
  }
  await Promise.all(workers);
}

describe('F3 determinism: every --json output is byte-identical across runs', () => {
  for (const c of CASES) {
    it(`${c.name}: 100 invocations produce identical stdout`, async () => {
      // Capture the first run as the reference.
      const baseline = await runGan(c.argv);
      expect(baseline.exitCode).toBe(0);
      expect(baseline.stdout.endsWith('\n')).toBe(true);

      // Round-trip property: parse the baseline JSON, re-emit it through
      // `emitJson`, and verify byte equality.
      const reparsed = emitJson(JSON.parse(baseline.stdout));
      expect(reparsed).toBe(baseline.stdout);

      // Run 99 more times and assert byte-equal stdout. A small
      // concurrency cap keeps wall time reasonable on dev laptops; the
      // R3 spec doesn't pin a number.
      const indices = Array.from({ length: c.runs - 1 }, (_, i) => i + 1);
      await runChunked(indices, 8, async () => {
        const r = await runGan(c.argv);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe(baseline.stdout);
      });
    }, 60_000);
  }
});
