/**
 * Wire-format constants and helpers for the confinement-hook backup
 * sibling files `gan hooks migrate` writes. The constants are the
 * migrate command's contract with downstream consumers — `gan hooks
 * status`, the `probeConfineHook` MCP tool, and any operator script
 * scanning `<project>/.claude/hooks/` — so this single home prevents
 * the three sites from drifting in lock-step.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Filename prefix every backup sibling carries. `gan hooks migrate`
 * composes a sibling as `<this prefix><utc-iso-timestamp>`; the
 * status command and the MCP tool wrapper recognise prior backups by
 * matching the same prefix. Changing the prefix is a wire-format
 * change and must update every consumer at once — co-locating the
 * constant in one module is the lock-step guarantee.
 */
export const BACKUP_SIBLING_PREFIX = 'gan-confine.sh.gan-bak.';

/**
 * List absolute paths of every `gan-confine.sh.gan-bak.<timestamp>`
 * file directly under `hooksDir`. Returns the sorted list so the JSON
 * surface that consumes the result (`gan hooks status --json`) is
 * deterministic. An absent or unreadable `hooksDir` yields an empty
 * array rather than throwing — every caller treats "no backups
 * present" the same as "could not enumerate" for the purpose of the
 * stable list contract.
 *
 * @param hooksDir absolute path to the `<project>/.claude/hooks/`
 *   directory to scan.
 * @returns sorted absolute paths to every matching sibling; `[]`
 *   when the directory does not exist, is not readable, or simply
 *   contains no matches.
 */
export function listBackupSiblings(hooksDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(hooksDir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const name of entries) {
    if (name.startsWith(BACKUP_SIBLING_PREFIX)) {
      matches.push(path.join(hooksDir, name));
    }
  }
  matches.sort();
  return matches;
}
