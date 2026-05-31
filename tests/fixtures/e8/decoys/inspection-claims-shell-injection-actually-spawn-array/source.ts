/**
 * Decoy source for the `inspection-claims-shell-injection-actually-spawn-array`
 * decoy.
 *
 * The faked finding's evidencePointer cites line 28 and claims a
 * shell-injection vector. The cited code in fact uses `spawn` with an
 * array-args invocation — the safe form that does NOT involve a shell. The
 * contract-reviewer's well-foundedness audit opens this file:line, sees the
 * safe form, and rejects the finding-derived criterion as ill-formed.
 */
import { spawn } from 'node:child_process';

/**
 * Pings a host via the system `ping` utility and resolves with its exit code.
 *
 * Uses the array-args form of `spawn` (no shell interpolation), so a hostile
 * `host` value cannot break out of the argument boundary — that safety is
 * exactly what the faked inspection finding falsely denies, and what the
 * contract-reviewer's well-foundedness audit confirms when it reads line 28.
 *
 * @param host the host argument passed to `ping -c 1`. Passed as a discrete
 *   argv element; no shell is invoked.
 * @returns the child process's exit code, or `0` when the child reports a
 *   null/undefined exit code.
 */
export function pingHost(host: string): Promise<number> {
  // Safe spawn-with-array form follows on the next line (line 28).
  const child = spawn('ping', ['-c', '1', host]);
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}
