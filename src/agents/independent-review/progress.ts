/**
 * Shared read-modify-write helper for `progress.json` writes the
 * independent-review subsystem performs.
 *
 * Two sibling writers in this folder funnel through this primitive:
 *
 * - `relock.ts` writes `status` and `contractRevision` across the two
 *   negotiating-then-building transitions of an atomic re-lock.
 * - `terminal-reason.ts`'s `buildFailedEvaluationRejectedRecord` builder
 *   produces the `terminal` + `terminalReason` fields the cap-with-blockers
 *   rejection writes; the MCP wrapper (and any direct TS caller) composes
 *   builder + this persister + atomic-write into one terminal record write.
 *
 * Keeping the read-modify-write in one module is what makes the two writers'
 * crash-safety stories byte-identical: both spread the existing
 * (prototype-sanitised) document first, layer their updates on top, serialise
 * with the framework's deterministic stringifier, and persist via
 * {@link atomicWriteFile} (the temp-file + rename primitive). The mirror in
 * `src/config-server/storage/run-progress.ts` (`recordWorkspace`) does the
 * same thing for the workspace field; both modules deliberately stay
 * independent — the workspace write lives at the run-context boundary and
 * never imports the independent-review subsystem.
 */

import { atomicWriteFile } from '../../config-server/storage/atomic-write.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import {
  readJsonObjectFile,
  stripForbiddenKeys,
} from '../../config-server/storage/json-read.js';

/**
 * Read-modify-write the fields named in `updates` onto `progress.json`,
 * preserving every other field already in the document.
 *
 * The pattern mirrors `recordWorkspace` in
 * `src/config-server/storage/run-progress.ts`: read the existing object
 * (sanitised against prototype-pollution keys), spread it first, then layer
 * the updates on top, then atomic-write. Spreading the base first guarantees
 * that an update never clobbers a field it does not explicitly name;
 * serialising via {@link stableStringify} guarantees byte-identical output
 * for equal state, so a recovery diff against the file can spot real
 * changes versus key-ordering noise.
 *
 * Synchronous: every primitive it composes (`readJsonObjectFile`,
 * `stripForbiddenKeys`, `stableStringify`, `atomicWriteFile`) is sync. The
 * function returns `void`; callers that need a `Promise` shape can wrap the
 * call themselves — see the dispatcher's `Promise<unknown> | unknown`
 * handler-return type for the MCP wire bridge.
 *
 * @param progressFilePath absolute path to `progress.json`.
 * @param updates the fields to set/replace on the document; every other
 *   existing field is preserved.
 */
export function writeProgressFields(
  progressFilePath: string,
  updates: Record<string, unknown>,
): void {
  const existing = readJsonObjectFile(progressFilePath);
  const base = existing === undefined ? {} : stripForbiddenKeys(existing);
  const next: Record<string, unknown> = { ...base, ...updates };
  atomicWriteFile(progressFilePath, stableStringify(next));
}
