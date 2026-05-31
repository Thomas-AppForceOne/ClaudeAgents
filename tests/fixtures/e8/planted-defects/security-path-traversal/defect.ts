/**
 * Defective `readDocument`: joins a caller-supplied `relativePath` to a fixed
 * `DOCS_ROOT` and reads the result, never verifying the resolved path stays
 * inside the root. A reviewer recognises that `relativePath = '../../etc/passwd'`
 * escapes the root and exposes arbitrary host files.
 *
 * Out-of-contract bug: the initial contract only says "read a doc by its
 * relative path under the docs root"; the planted defect is the missing
 * containment check.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DOCS_ROOT = '/srv/app/docs';

/**
 * Read a UTF-8 document under {@link DOCS_ROOT}.
 *
 * @param relativePath caller-supplied path. Untrusted.
 */
export function readDocument(relativePath: string): string {
  // BUG: no validation that the resolved path is inside DOCS_ROOT.
  // Should: const resolved = path.resolve(DOCS_ROOT, relativePath);
  //         if (!resolved.startsWith(DOCS_ROOT + path.sep)) throw new Error('forbidden');
  const full = path.join(DOCS_ROOT, relativePath);
  return readFileSync(full, 'utf8');
}
