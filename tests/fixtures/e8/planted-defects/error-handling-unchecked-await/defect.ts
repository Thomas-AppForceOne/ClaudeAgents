/**
 * Defective `loadConfig`: the JSDoc declares `@throws never`, but the body
 * `await`s an `fs.readFile` that can reject with `ENOENT`, `EACCES`, etc.
 * The function therefore CAN throw — the doc contract is a lie, and a caller
 * that omits a try/catch surfaces an unhandled rejection.
 *
 * Out-of-contract bug: the initial contract took the JSDoc at face value;
 * the planted defect is the mismatch between the documented and actual
 * throw surface.
 */
import { readFile } from 'node:fs/promises';

/**
 * Read and parse the config file at `path`.
 *
 * @param p absolute path to the config file.
 * @throws never — defect: in fact this rejects on any I/O or parse error.
 */
export async function loadConfig(p: string): Promise<Record<string, unknown>> {
  // BUG: await can reject; @throws contract says it never does.
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}
