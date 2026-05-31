/**
 * Decoy source for the `inspection-claims-shell-injection-actually-spawn-array`
 * decoy.
 *
 * The faked finding's evidencePointer cites line 15 and claims a
 * shell-injection vector. The cited code in fact uses `spawn` with an
 * array-args invocation — the safe form that does NOT involve a shell. The
 * contract-reviewer's well-foundedness audit opens this file:line, sees the
 * safe form, and rejects the finding-derived criterion as ill-formed.
 */
import { spawn } from 'node:child_process';

export function pingHost(host: string): Promise<number> {
  // Safe spawn-with-array form follows on the next line (line 15).
  const child = spawn('ping', ['-c', '1', host]);
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}
