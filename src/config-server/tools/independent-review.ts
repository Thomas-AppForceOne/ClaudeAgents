/**
 * Independent-review MCP tool handlers — three thin wrappers over the
 * shipped `src/agents/independent-review/` library plus the shared
 * `progress.json` persister. Mirrors `src/config-server/tools/trace.ts`'s
 * thin-handler pattern: each handler forwards to the library and surfaces
 * the same return shape a direct library import would.
 *
 * The wrappers exist for two reasons the cluster-2 analysis named:
 *
 * 1. **Markdown orchestrator reachability.** The library functions cannot
 *    be invoked from `skills/gan/SKILL.md` directly — the orchestrator
 *    speaks the MCP wire. These handlers are what makes the three helpers
 *    callable from the renegotiation-loop section of SKILL.md (named under
 *    the kebab-case tool names registered in `../index.ts`).
 *
 * 2. **Symmetric composition seam.** The terminal-reason builder
 *    (`buildFailedEvaluationRejectedRecord`) is a pure builder symmetric
 *    with `buildLoopHaltTerminalRecord`; persistence lives in the shared
 *    `writeProgressFields` primitive. The MCP wrapper composes builder +
 *    persister into one tool call so the wire shape stays uniform — the
 *    orchestrator sees one tool per terminal class, not a builder-then-
 *    persister two-step it has to compose itself.
 *
 * The relock wrapper does NOT bridge a callback across the wire (the
 * markdown orchestrator cannot supply a TS function). Instead it expects
 * the draft to already be written at `newDraftPath` and performs only the
 * archive + swap + RMW protocol — the canonical re-lock atomicity invariants
 * are preserved because the library's pre-swap existence check still
 * refuses to proceed when the draft is missing.
 *
 * The validate-findings wrapper supplies a safe-by-default command runner:
 * `spawnSync` under `/bin/sh -c` confinement, mapping a synchronous throw
 * to the `reproduction-errored` `DropReason` the gate's enumerated verdicts
 * now expose. The schema's metacharacter-banning `pattern` (see
 * `schemas/independent-review-v1.json`) and the gate's defence-in-depth
 * `UNSAFE_COMMAND_CHARACTERS` regex (see
 * `src/agents/independent-review/finding-validation.ts`) together refute
 * the dangerous shell sequences before the runner is ever invoked; the
 * shell here is what executes the otherwise-safe multi-token shapes the
 * schema admits (test runners with file-path arguments, `grep -nE …`,
 * and similar).
 */

import { spawnSync } from 'node:child_process';

import {
  buildFailedEvaluationRejectedRecord,
  type BuildFailedEvaluationRejectedOptions,
  type BuildFailedEvaluationRejectedResult,
} from '../../agents/independent-review/terminal-reason.js';
import { writeProgressFields } from '../../agents/independent-review/progress.js';
import {
  archivedContractPath,
  canonicalContractPath,
} from '../../agents/independent-review/relock.js';
import { validateFindings as libraryValidateFindings } from '../../agents/independent-review/finding-validation.js';
import type {
  CommandRunner,
  CommandRunnerResult,
  IndependentReviewBundle,
  ValidateFindingsResult,
} from '../../agents/independent-review/types.js';
import {
  readJsonObjectFile,
  stripForbiddenKeys,
} from '../storage/json-read.js';
import { existsSync, renameSync } from 'node:fs';

/**
 * Input to {@link relockContractTool}.
 *
 * The wrapper omits the library's `runRound` callback: the markdown
 * orchestrator cannot pass a TS function across the MCP wire, so it instead
 * writes the audited draft itself and passes the on-disk path. The handler
 * then performs only the archive + canonical-swap + progress.json read-
 * modify-write protocol.
 *
 * @property runDir absolute path to the run directory.
 * @property sprintNumber 1-based sprint index `{N}`.
 * @property newDraftPath absolute path of the audited draft the orchestrator
 *   already wrote. The handler asserts the path exists (mirroring the
 *   library's fail-fast contract) before touching the canonical.
 * @property progressFilePath absolute path to `progress.json`. The handler
 *   read-modify-writes this file atomically.
 */
export interface RelockContractToolInput {
  runDir: string;
  sprintNumber: number;
  newDraftPath: string;
  progressFilePath: string;
}

/**
 * Result of {@link relockContractTool}.
 *
 * @property newRevision the contract revision now canonical, equal to the
 *   pre-call `progress.json.contractRevision` plus one.
 * @property archivedPath absolute path of the archived `.r{k}.json` sibling.
 * @property mutated always `true` on a successful re-lock — surfaced under
 *   the uniform F2 `mutated` name so the orchestrator can OR it in with the
 *   other R7 write tools.
 */
export interface RelockContractToolResult {
  newRevision: number;
  archivedPath: string;
  mutated: true;
}

/**
 * Wire-bound re-lock handler.
 *
 * Sequence (matches the library's `relockContractCore`, minus the callback
 * because the orchestrator writes the draft itself):
 * 1. Read `progress.json.contractRevision` (defaulting to 0 when absent).
 * 2. Write `status: "negotiating"` onto `progress.json`.
 * 3. Refuse if `newDraftPath` does not exist — the prior canonical is still
 *    in place, so restoring `status: "building"` is the only rollback
 *    needed.
 * 4. Archive the canonical to its `.r{k}.json` sibling (skip when the
 *    canonical does not exist).
 * 5. Atomic-rename `newDraftPath` onto the canonical filename. On a swap
 *    failure after a successful archive, rename the archive back so the
 *    on-disk story remains "prior revision is canonical".
 * 6. Read-modify-write `progress.json`: increment `contractRevision`, set
 *    `status: "building"`.
 *
 * Synchronous: every step composes a sync primitive. The dispatcher's
 * `Promise<unknown> | unknown` handler-return type bridges to the wire's
 * Promise convention without an explicit `Promise.resolve`.
 *
 * @param input see {@link RelockContractToolInput}.
 * @returns see {@link RelockContractToolResult}.
 * @throws an `Error` whose message starts with `relockContractTool:
 *   newDraftPath does not exist` when the draft is missing on disk;
 *   `progress.json` is restored to `status: "building"` before the throw.
 * @throws the underlying `fs.rename` error verbatim when the archive or
 *   canonical swap fails; mirrors the library's "surface I/O failures
 *   verbatim" contract.
 */
export function relockContractTool(input: RelockContractToolInput): RelockContractToolResult {
  const { runDir, sprintNumber, newDraftPath, progressFilePath } = input;
  const canonical = canonicalContractPath(runDir, sprintNumber);
  const priorRevision = readContractRevision(progressFilePath);
  const archived = archivedContractPath(runDir, sprintNumber, priorRevision);

  writeProgressFields(progressFilePath, { status: 'negotiating' });

  let archivedFromCanonical = false;
  try {
    if (!existsSync(newDraftPath)) {
      throw new Error(
        `relockContractTool: newDraftPath does not exist at ${newDraftPath}; the orchestrator must write the audited draft before invoking the tool.`,
      );
    }

    if (existsSync(canonical)) {
      renameSync(canonical, archived);
      archivedFromCanonical = true;
    }

    try {
      renameSync(newDraftPath, canonical);
    } catch (swapErr) {
      if (archivedFromCanonical) {
        try {
          renameSync(archived, canonical);
          archivedFromCanonical = false;
        } catch (rollbackErr) {
          void rollbackErr;
          throw new Error(
            `relockContractTool: canonical swap failed (${(swapErr as Error).message}) and rollback of archived sibling ${archived} -> ${canonical} also failed; prior revision is at ${archived}`,
            { cause: swapErr as Error },
          );
        }
      }
      throw swapErr;
    }

    writeProgressFields(progressFilePath, {
      contractRevision: priorRevision + 1,
      status: 'building',
    });

    return {
      newRevision: priorRevision + 1,
      archivedPath: archived,
      mutated: true,
    };
  } catch (err) {
    writeProgressFields(progressFilePath, { status: 'building' });
    throw err;
  }
}

/**
 * Input to {@link writeFailedEvaluationRejectedTool}: the builder's options
 * plus the `progressFilePath` the persister writes onto.
 */
export interface WriteFailedEvaluationRejectedToolInput
  extends BuildFailedEvaluationRejectedOptions {
  progressFilePath: string;
}

/**
 * Result of {@link writeFailedEvaluationRejectedTool}: the builder's result
 * augmented with the uniform F2 `mutated` indicator (true when the
 * persister fired, false on a no-op).
 */
export interface WriteFailedEvaluationRejectedToolResult
  extends BuildFailedEvaluationRejectedResult {
  mutated: boolean;
}

/**
 * Compose builder + shared persister + atomic write at the wire boundary.
 *
 * Calls {@link buildFailedEvaluationRejectedRecord} with the cap/blocker
 * inputs; on a write decision, merges the returned record into
 * `progress.json` via {@link writeProgressFields}. On a no-op decision
 * (`write: false`) the handler is a true no-op — `progress.json` is not
 * touched.
 *
 * This is the canonical wire shape for the cap-with-blockers rejection
 * write: one MCP call per terminal record, symmetric with the loop-halt
 * record's eventual wire-side composition.
 *
 * @param input see {@link WriteFailedEvaluationRejectedToolInput}.
 * @returns see {@link WriteFailedEvaluationRejectedToolResult}.
 */
export function writeFailedEvaluationRejectedTool(
  input: WriteFailedEvaluationRejectedToolInput,
): WriteFailedEvaluationRejectedToolResult {
  const { progressFilePath, capFired, unresolvedBlockers } = input;
  const built = buildFailedEvaluationRejectedRecord({ capFired, unresolvedBlockers });
  if (built.write && built.record !== undefined) {
    // Spread into a Record<string, unknown> so writeProgressFields' merge
    // signature accepts the structurally narrower terminal-record type.
    writeProgressFields(progressFilePath, { ...built.record });
    return { ...built, mutated: true };
  }
  return { ...built, mutated: false };
}

/**
 * Input to {@link validateFindingsTool}: the reviewer bundle. The runner is
 * not exposed on the wire; the handler installs a default safe runner that
 * spawns `/bin/sh -c <command>` and surfaces the `CommandRunnerResult`
 * shape. A throwing runner is caught inside the library at the per-finding
 * boundary and recorded as `reproduction-errored`.
 *
 * @property bundle the reviewer-authored bundle (schema-valid). The library
 *   walks `bundle.findings` in order.
 */
export interface ValidateFindingsToolInput {
  bundle: IndependentReviewBundle;
}

/**
 * The default safe-runner the MCP wrapper installs. Spawns the command
 * under `/bin/sh -c` so multi-token shapes the schema admits (e.g. a
 * test-runner invocation with file-path arguments) execute as a single
 * command; the schema's metacharacter `pattern` plus the gate's
 * `UNSAFE_COMMAND_CHARACTERS` regex have already refuted the dangerous
 * shell sequences (`;`, `&`, `|`, backtick, `$`, `<`, `>`, newline, NUL,
 * backslash) before the runner is invoked.
 *
 * On a `spawnSync` failure (no shell binary, signal interruption, etc.),
 * surfaces a synthetic non-zero exit and the captured stderr so the gate's
 * downstream verdict is `reproduction-failed`; on an actual JS throw the
 * library's try/catch maps it to `reproduction-errored`. Stdout/stderr are
 * captured as UTF-8 strings so the dropped-finding record can quote them
 * directly.
 */
function defaultSafeCommandRunner(cmd: string): CommandRunnerResult {
  const result = spawnSync('/bin/sh', ['-c', cmd], {
    encoding: 'utf8',
    // Inherit cwd from the calling process; the orchestrator pre-sets cwd
    // to the worktree root before invoking the tool (the same convention
    // the docker tools use).
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // `spawnSync` returns either an exit code, a signal, or an error. Map
  // each shape onto the CommandRunnerResult contract:
  // - exit code present → use it verbatim (0 keeps, non-zero drops).
  // - signal-terminated → synthetic non-zero exit so the gate drops as
  //   reproduction-failed (the signal is the dropped record's evidence
  //   in stderr).
  // - spawn error → throw so the library's per-finding try/catch records
  //   reproduction-errored.
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return {
    exitCode,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/**
 * Run the reproduction gate over a bundle, using the default safe runner.
 *
 * The library's gate (`validateFindings`) is byte-thin pure logic; this
 * wrapper supplies the H1-confined runner the orchestrator would otherwise
 * have to construct itself. A caller may not override the runner via the
 * wire — the wire boundary is exactly where the safe-runner default is
 * load-bearing; an injected runner would defeat the wrapper's purpose.
 *
 * @param input see {@link ValidateFindingsToolInput}.
 * @returns the {@link ValidateFindingsResult} the library produces.
 */
export function validateFindingsTool(input: ValidateFindingsToolInput): ValidateFindingsResult {
  return libraryValidateFindings(input.bundle, defaultSafeCommandRunner satisfies CommandRunner);
}

// Internal helper mirroring the library's pre-call read of
// `progress.json.contractRevision`. Kept colocated rather than re-exported
// from `relock.ts` because it is a defensive read with `0` as the default,
// not a public API.
function readContractRevision(progressFilePath: string): number {
  const obj = readJsonObjectFile(progressFilePath);
  if (obj === undefined) return 0;
  const sanitised = stripForbiddenKeys(obj);
  const v = sanitised['contractRevision'];
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return 0;
}

