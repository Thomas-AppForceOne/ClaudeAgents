/**
 * MCP tool wrapper exposing the shared confine-hook probe runner to the
 * skill-side preflight. The skill-side preflight runs in markdown; the
 * probe is TypeScript. This module is the bridge — a pure marshalling
 * wrapper around {@link runConfineHookProbe} that resolves the project-tier
 * hook path, calls the shared runner when the file exists, lists the
 * `.gan-bak.*` siblings the migrate command writes, and projects the
 * runner's verdict + subReason into the documented MCP shape.
 *
 * The wrapper contains NO probe logic of its own: that is the
 * single-shared-runner invariant the byte-identical-with-status assertion
 * depends on. A future hook-contract change is a one-location edit at
 * `runConfineHookProbe`; this wrapper composes unchanged.
 */

import { statSync } from 'node:fs';
import path from 'node:path';

import {
  listBackupSiblings,
  runConfineHookProbe,
  type ConfineProbeSubReason,
  type ConfineProbeVerdict,
} from '../../hook-probe/index.js';

/**
 * Input to {@link probeConfineHook}.
 *
 * @property projectRoot the absolute path to the resolved project root.
 *   The wrapper composes `<projectRoot>/.claude/hooks/gan-confine.sh` as
 *   the candidate hook path without re-canonicalising — the orchestrator
 *   has already resolved the root via the standard `resolveProjectRoot`
 *   helper.
 */
export interface ProbeConfineHookInput {
  projectRoot: string;
}

/**
 * Result of {@link probeConfineHook}.
 *
 * The shape mirrors the documented contract on the H3 spec:
 *
 * @property projectTierHookPath the absolute path the wrapper composed
 *   under `<projectRoot>/.claude/hooks/gan-confine.sh`; `null` when no file
 *   exists at that path. The skill-side preflight uses `null` here to
 *   short-circuit (no project-tier hook means the user-tier hook applies
 *   and the framework guarantees it is current).
 * @property verdict one of `'current'`, `'stale'`, `'misconfigured'`, or
 *   `null`. The `null` value pairs strictly with `projectTierHookPath ===
 *   null` — when no file exists there is nothing to classify.
 * @property subReason the per-verdict discriminator the diagnostic envelope
 *   surfaces — `'noGanRunDirAwareness'` for the stale case,
 *   `'projectHookMisconfigured'` for the non-bash case, `null` otherwise
 *   (current verdict or no hook present).
 * @property backupSiblings absolute paths of every
 *   `gan-confine.sh.gan-bak.<timestamp>` file the wrapper found in
 *   `<projectRoot>/.claude/hooks/`. Present-and-empty (`[]`) when the hook
 *   directory exists but holds no backup siblings; an empty array also
 *   surfaces when the hook directory itself is absent.
 */
export interface ProbeConfineHookResult {
  projectTierHookPath: string | null;
  verdict: ConfineProbeVerdict | null;
  subReason: ConfineProbeSubReason;
  backupSiblings: string[];
}

/**
 * Probe the project-tier confinement hook. The function is the
 * skill-to-probe bridge: it composes the canonical hook path under the
 * project root, calls the shared {@link runConfineHookProbe} when the file
 * exists, and assembles the documented {@link ProbeConfineHookResult}
 * shape. The skill-side preflight halts the run on
 * `verdict === 'stale' | 'misconfigured'`; on `verdict === 'current'` or
 * `projectTierHookPath === null` the run proceeds.
 *
 * Failure modes:
 * - The hook file is absent → `verdict: null, subReason: null,
 *   projectTierHookPath: null, backupSiblings: []` (no halt).
 * - The hook file is unreadable or has no shebang → `verdict:
 *   'misconfigured', subReason: 'projectHookMisconfigured'`.
 * - The hook returns non-zero on the allow-listed probe target →
 *   `verdict: 'stale', subReason: 'noGanRunDirAwareness'`.
 * - The hook returns zero → `verdict: 'current', subReason: null`.
 *
 * Side effects: delegates a temp tree create/cleanup to
 * {@link runConfineHookProbe}; this wrapper itself only reads. Never
 * throws — every failure mode collapses to one of the documented shapes.
 *
 * @param input see {@link ProbeConfineHookInput}.
 * @returns the {@link ProbeConfineHookResult}.
 */
export async function probeConfineHook(
  input: ProbeConfineHookInput,
): Promise<ProbeConfineHookResult> {
  const hooksDir = path.join(input.projectRoot, '.claude', 'hooks');
  const hookPath = path.join(hooksDir, 'gan-confine.sh');
  const fileExists = isFileAt(hookPath);
  const backupSiblings = listBackupSiblings(hooksDir);
  if (!fileExists) {
    return {
      projectTierHookPath: null,
      verdict: null,
      subReason: null,
      backupSiblings,
    };
  }
  const result = await runConfineHookProbe({ hookPath });
  return {
    projectTierHookPath: hookPath,
    verdict: result.verdict,
    subReason: result.subReason,
    backupSiblings,
  };
}

// True when `p` exists and is a regular file. A directory at the hook path
// is treated as not-a-hook — the spawn would fail anyway, and the surface
// reads more clearly when the wrapper short-circuits on "no file" without
// classifying the directory as `misconfigured`.
function isFileAt(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
