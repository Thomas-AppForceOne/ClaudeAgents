/**
 * Determinism stress test for every `--json` surface (feature backstop F3).
 *
 * F3's contract is that JSON output is byte-stable: the same command run any
 * number of times yields identical stdout. A single comparison can pass by
 * luck (object-key order, timestamps, and float formatting only sometimes
 * vary), so this suite runs each read command 100 times and requires every
 * invocation to match a baseline byte-for-byte. It also checks the inverse
 * direction once per case: re-emitting the parsed baseline through the CLI's
 * own `emitJson` must reproduce the exact bytes, proving the emitter — not just
 * the underlying data — is the canonical, idempotent serializer.
 */

import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';
import { emitJson } from '../../src/cli/lib/json-output.js';

const FIXTURE_MIN = stackFixturePath('js-ts-minimal');
const FIXTURE_POLYGLOT = stackFixturePath('polyglot-webnode-synthetic');

// One entry per JSON-emitting read command. `runs` is the repetition count the
// determinism check enforces; the polyglot vs minimal fixtures exercise both a
// populated and an empty active-stack set.
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

// Bounded-concurrency runner: drains `items` through at most `cap` parallel
// workers. The 100-run determinism checks would overwhelm the machine if every
// spawn fired at once, so this caps in-flight child processes while still
// parallelising for speed. Each worker pulls the next item off a shared queue
// until it is empty.
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

      // First run establishes the byte baseline every later run must match.
      const baseline = await runGan(c.argv);
      expect(baseline.exitCode).toBe(0);
      expect(baseline.stdout.endsWith('\n')).toBe(true);

      // Idempotency of the emitter itself: parse the baseline and re-serialize
      // through emitJson — it must reproduce the exact bytes, so emitJson is the
      // canonical fixed point, not merely consistent with whatever produced it.
      const reparsed = emitJson(JSON.parse(baseline.stdout));
      expect(reparsed).toBe(baseline.stdout);

      // Remaining runs-1 invocations, capped at 8 concurrent spawns; every one
      // must equal the baseline byte-for-byte.
      const indices = Array.from({ length: c.runs - 1 }, (_, i) => i + 1);
      await runChunked(indices, 8, async () => {
        const r = await runGan(c.argv);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe(baseline.stdout);
      });
      // 60s budget: 100 cold CLI spawns per case can be slow under load.
    }, 60_000);
  }
});
