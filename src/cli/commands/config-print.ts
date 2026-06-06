/**
 * `gan config print` — print a human-readable summary of the fully resolved
 * config for a project (api/schema versions, active stacks, discarded paths,
 * additional-context registrations, and the issue count).
 *
 * A read-only command. It calls {@link getResolvedConfig} (which is itself
 * fail-open at the data layer — error-severity issues are captured into the
 * returned object's `issues` array rather than thrown), renders the resolved
 * view, then maps the resolved `issues` to the process exit code via
 * {@link exitCodeForIssues}. The `--json` form emits the entire resolved-config
 * object verbatim — the same flat shape downstream surfaces (the orchestrator
 * snapshot, `/gan --print-config --json`) consume — so any field added to the
 * shape downstream appears here with no edit. The human form is the curated
 * subset rendered by {@link renderHuman}, which prints `additionalContext`
 * registrations with a `(missing)` affordance on rows whose file does not exist
 * (the missing-file marker the human renderer is required to surface, not
 * silently drop) and prints warnings as prose below the table.
 *
 * Why not {@link runRead}: this command needs a per-command exit-code policy —
 * exit non-zero when the resolver captured error-severity `issues`, even
 * though the resolver did not throw — that the shared helper deliberately does
 * not encode. Keeping the special case here rather than threading an exit-code
 * mapper through {@link runRead} preserves the aborting-on-error invariant
 * every other read command relies on.
 */

import { getResolvedConfig } from '../../index.js';
import { renderWarningLines } from '../lib/warnings-render.js';
import { readSharedFlags, errorResult, type CommandResult } from '../lib/run-helpers.js';
import { exitCodeForIssues } from '../lib/exit-codes.js';
import { emitJson } from '../lib/json-output.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import type { ResolvedConfig, AdditionalContextRow } from '../../index.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Format one `additionalContext` role's rows for the human render.
 *
 * Rows whose backing file is missing on disk receive a trailing ` (missing)`
 * suffix so the human reader sees the same `exists: false` signal the JSON
 * form carries — the missing-file marker must not be silently dropped from
 * the human surface. An empty role renders as the empty list `[]` literally,
 * matching the prior format.
 *
 * @param rows the resolved context-file rows for one role (planner or
 *   proposer); each row carries `{path, exists}` from the resolver.
 * @returns a comma-separated list of `path` (or `path (missing)`) tokens,
 *   wrapped in `[]` so the surrounding `role=[...]` shape stays stable.
 */
function formatAdditionalContextRows(rows: readonly AdditionalContextRow[]): string {
  const tokens = rows.map((r) => (r.exists ? r.path : `${r.path} (missing)`));
  return `[${tokens.join(', ')}]`;
}

/**
 * Render the curated, human-readable summary of a resolved config.
 *
 * When the snapshot carries one or more non-aborting warnings, they are printed
 * as structured prose BELOW the key:value table — reusing the same per-warning
 * `<code>: <message>` prose the orchestrator startup log emits (the warning's
 * own `message`), so there is one warning-prose source across surfaces. The
 * warnings are read verbatim from the snapshot in the data layer's order; the
 * command does not recompute them. When no warning applies, the output is the
 * existing table verbatim with no warnings section.
 *
 * @param resolved the fully resolved config to summarise.
 * @returns aligned `key: value` lines (trailing newline). `(none)` stands in
 *   for empty stack / discarded lists, and `additionalContext` reduces to the
 *   registration `path`s for the planner and proposer roles with a trailing
 *   ` (missing)` marker on rows whose file does not exist on disk. A
 *   `warnings:` section, blank-line-separated from the table, is appended only
 *   when warnings are present.
 */
function renderHuman(resolved: ResolvedConfig): string {
  const lines: string[] = [];
  lines.push(`apiVersion:        ${resolved.apiVersion}`);
  lines.push(
    `schemaVersions:    stack=${resolved.schemaVersions.stack} overlay=${resolved.schemaVersions.overlay}`,
  );
  const active = resolved.stacks.active;
  lines.push(`active stacks:     ${active.length === 0 ? '(none)' : active.join(', ')}`);
  lines.push(
    `discarded paths:   ${resolved.discarded.length === 0 ? '(none)' : resolved.discarded.join(', ')}`,
  );
  lines.push(
    `additionalContext: planner=${formatAdditionalContextRows(
      resolved.additionalContext.planner,
    )} proposer=${formatAdditionalContextRows(resolved.additionalContext.proposer)}`,
  );
  lines.push(`issues:            ${resolved.issues.length}`);

  // The warnings section is appended only when there is something to show, so a
  // clean snapshot's output stays byte-for-byte the pre-W1 table. A blank line
  // visually separates the prose block from the aligned table above it.
  if (resolved.warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    lines.push(renderWarningLines(resolved.warnings));
  }
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan config print`.
 *
 * Behaviour contract:
 * - Resolves the project root; a thrown `ConfigServerError` here renders via
 *   {@link errorResult} and short-circuits the command (the resolver never
 *   ran, so there is no resolved view to fail-open with).
 * - Calls {@link getResolvedConfig}, which is itself fail-open — it captures
 *   validation errors into `resolved.issues` rather than throwing, so the
 *   command always has a (possibly partial) resolved view to print.
 * - Renders the view (JSON or human) and maps `resolved.issues` to the exit
 *   code via {@link exitCodeForIssues}: `EXIT_OK` (0) when no error-severity
 *   issues, `EXIT_INVARIANT_VIOLATION` (4) when any error is an
 *   `InvariantViolation`, else `EXIT_VALIDATION` (2). Warning-severity issues
 *   and the separate `warnings[]` array never affect the exit code.
 * - The fail-open path emits only what the resolver produced: the resolved
 *   object's `issues` and `warnings` arrays. The command never stringifies
 *   exception payloads, stack traces, or environment values into output.
 *
 * @param parsed parsed argv; honours `--json` and `--project-root` via
 *   {@link readSharedFlags}.
 * @returns a {@link CommandResult}; the exit code reflects validation status
 *   per the policy above. Never throws.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson, rootFlag } = readSharedFlags(parsed);

  // Resolve the root before the body so an invalid --project-root fails fast
  // with its own structured error — there is no resolved view to fail-open
  // with at this stage.
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(rootFlag).path;
  } catch (e) {
    return errorResult(e, wantJson);
  }

  // getResolvedConfig is fail-open at the data layer: error-severity issues
  // are captured into `resolved.issues` rather than thrown. A throw here
  // therefore means a genuinely-unexpected I/O fault (or a broken install) —
  // funnel it through the same error-result envelope every other read
  // command uses.
  let resolved: ResolvedConfig;
  try {
    resolved = await getResolvedConfig({ projectRoot });
  } catch (e) {
    return errorResult(e, wantJson);
  }

  const stdout = wantJson ? emitJson(resolved) : renderHuman(resolved);
  const code = exitCodeForIssues(resolved.issues);
  return { stdout, stderr: '', code };
}
