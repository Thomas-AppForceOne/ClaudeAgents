/**
 * E3 — Evaluator deterministic core types.
 *
 * Public types for the evaluator-core carve-out. The carve-out is a pure
 * function over typed data: agents (E1) and orchestrator scripts
 * (`scripts/evaluator-pipeline-check`) assemble the inputs and call
 * `buildEvaluatorPlan`. No file I/O happens inside this module.
 *
 * Shapes mirror E3 lines 28-61 (the "evaluator plan" JSON example) plus
 * the typed inputs the orchestrator must construct from F2's
 * `getResolvedConfig()` snapshot.
 */

// ---- Inputs --------------------------------------------------------------

/**
 * Audit command shape, mirroring C1's `auditCmd` block. Stack files
 * supply the structured form; the carve-out treats it as opaque data.
 */
export interface AuditCmd {
  command: string;
  absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  absenceMessage?: string;
}

/**
 * Documentation-lint command shape, mirroring Q5's `docLintCmd` block.
 *
 * Structurally `AuditCmd` plus two gating fields the documentation layer
 * adds — `severity` (the gates-or-warns knob) and `baseline` (delta vs.
 * absolute comparison). Like `AuditCmd` the carve-out treats every field
 * as opaque data: it carries them onto the emitted plan entry verbatim and
 * never acts on them. The *acting-on* — running the command, comparing
 * against the base ref, routing by severity — lives downstream at the
 * layer that runs `auditCmd`/`lintCmd` (the evaluator agent), because that
 * is the only layer with the git base ref the comparison needs; the
 * carve-out is pure over `(snapshot, sprintPlan, worktreeState)` and has
 * no base-ref input.
 *
 * - `command` — the ecosystem-specific doc-lint invocation. The only
 *   ecosystem token; it lives in the owning stack file, never the prompt.
 * - `absenceSignal` — what to do when the tool is missing on the host,
 *   identical semantics to `AuditCmd.absenceSignal`.
 * - `absenceMessage` — the warning text surfaced when `absenceSignal`
 *   fires; required by the stack schema whenever `absenceSignal` is not
 *   `silent` (mirrors the `auditCmd` `oneOf` shape).
 * - `severity` — the gating policy: `blocker` fails the attempt,
 *   `warning` records-and-surfaces, `advisory` routes onward and never
 *   blocks. Acted on downstream, carried verbatim here.
 * - `baseline` — `delta` (default) compares only the sprint's diff
 *   against the base ref; `absolute` flags pre-existing debt too. Optional
 *   on the stack; the emission layer applies the `delta` default when it
 *   is omitted (see `buildDocLintInvocations`).
 */
export interface DocLintCmd {
  command: string;
  absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  absenceMessage?: string;
  severity: 'blocker' | 'warning' | 'advisory';
  baseline?: 'delta' | 'absolute';
}

/**
 * Security surface, mirroring C1's `securitySurfaces[*]` entry.
 *
 * `triggers.scope` and `triggers.keywords` are both optional. A surface
 * with neither is instantiated unconditionally whenever the stack is
 * active and the sprint touches any file in the stack's `scope` (per C1
 * "Template instantiation protocol").
 */
export interface SecuritySurface {
  id: string;
  template: string;
  triggers?: {
    keywords?: string[];
    scope?: string[];
  };
}

/**
 * Documentation surface, mirroring Q5's `documentationSurfaces[*]` entry.
 *
 * Structurally identical to `SecuritySurface` (id + verbatim template +
 * optional scope/keyword triggers). It is declared as a distinct type
 * rather than aliased to `SecuritySurface` so that the two surface
 * families remain independently evolvable: Q5 may later add doc-specific
 * trigger fields without perturbing the security shape, and the union
 * existence-check (security ∪ documentation) reads more honestly when the
 * two members are nominally distinct rather than the same type twice.
 */
export interface DocumentationSurface {
  id: string;
  template: string;
  triggers?: {
    keywords?: string[];
    scope?: string[];
  };
}

/**
 * The carve-out's snapshot input. Wraps F2's `ResolvedConfig` with the
 * parsed stack bodies attached so this module remains pure (no
 * file-reading from disk).
 *
 * Sprint 3's orchestrator builds this shape from `getResolvedConfig()`
 * plus the parsed stack file bodies (which are already in the validation
 * snapshot under `stackFiles[name].data` per R1's loader). The carve-out
 * only consumes the assembled shape.
 */
export interface EvaluatorCoreSnapshot {
  /**
   * Active stacks with their parsed body fields. The order of entries
   * here is not significant; the plan-builder sorts active stacks by
   * `name` per E3's normalisation rule.
   */
  activeStacks: Array<{
    name: string;
    scope: string[];
    secretsGlob?: string[];
    auditCmd?: AuditCmd;
    docLintCmd?: DocLintCmd;
    buildCmd?: string;
    testCmd?: string;
    lintCmd?: string;
    securitySurfaces?: SecuritySurface[];
    documentationSurfaces?: DocumentationSurface[];
  }>;
  /**
   * Cascaded overlay splice points the evaluator plan splices in. The
   * snapshot is already cascaded (per C4); the carve-out passes through
   * `evaluator.additionalChecks` verbatim.
   */
  mergedSplicePoints: {
    'evaluator.additionalChecks'?: Array<{
      command: string;
      on_failure: string;
      tier: string;
    }>;
  };
}

/**
 * Synthetic sprint plan input (per E3). In production this is the
 * planner agent's output; for the harness it is hand-authored JSON. The
 * carve-out treats it as data — only `affectedFiles` influences the
 * deterministic decisions; `criteria` is carried forward to downstream
 * LLM evaluation.
 */
export interface SprintPlan {
  /** Repo-relative paths the planner says will be touched. */
  affectedFiles: string[];
  /** Contract criteria the proposer issued for this sprint. */
  criteria: Array<{ id: string; description: string }>;
}

/**
 * Worktree state input. The carve-out is pure: callers pre-load the
 * file enumeration and (when keyword matching is needed) the file
 * contents. If `fileContents[path]` is undefined for a file path,
 * keyword scans for that file return empty matches without erroring.
 */
export interface WorktreeState {
  /** Repo-relative paths the evaluator can see. */
  files: string[];
  /**
   * Optional pre-loaded text content for keyword matching. Key is the
   * repo-relative path; value is the file's UTF-8 text. A missing key
   * is treated as "no content available, skip keyword matching for
   * that file".
   */
  fileContents?: Record<string, string>;
}

// ---- Output --------------------------------------------------------------

/**
 * The evaluator plan — E3 lines 28-61.
 *
 * Every array is deterministic: helpers sort by `name` /
 * `(stack, extension)` / lexicographically inside each entry's file
 * lists, so the assembled plan is byte-stable across calls with the
 * same inputs.
 */
export interface EvaluatorPlan {
  activeStacks: Array<{ name: string; scope: string[] }>;
  secretsScans: Array<{ stack: string; extension: string; files: string[] }>;
  auditCommands: Array<{
    stack: string;
    command: string;
    absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  }>;
  /**
   * Q5 layer (b) — per-stack `docLintCmd` invocations the downstream
   * execution layer runs. One row per active stack that declares
   * `docLintCmd`; a stack without the field contributes none (the absence
   * is itself the signal, parallel to `auditCommands`).
   *
   * Every field is *carried* from the stack's `docLintCmd` for the
   * downstream layer to act on — the carve-out runs no command, performs
   * no baseline comparison, and applies no gating. `scope` is the owning
   * stack's own `scope` (never another stack's), which is what scopes the
   * command to its ecosystem's files in a polyglot run. `baseline` is
   * always present on the row even when the stack omits it: the emission
   * layer fills the `delta` default so the downstream layer never has to
   * re-derive it. Sorted by `stack` for byte-stable plan output.
   */
  docLintInvocations: Array<{
    stack: string;
    command: string;
    scope: string[];
    severity: 'blocker' | 'warning' | 'advisory';
    baseline: 'delta' | 'absolute';
    absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  }>;
  buildTestLint: { buildCmd?: string; testCmd?: string; lintCmd?: string };
  securitySurfacesInstantiated: Array<{
    stack: string;
    id: string;
    templateText: string;
    triggerEvidence: { scopeMatched: string[]; keywordsHit: string[] };
    appliesToFiles: string[];
  }>;
  /**
   * Q5 layer (c) — `documentationSurfaces` instantiated into gating
   * contract criteria. Same row shape as `securitySurfacesInstantiated`
   * (the two surface families instantiate through the identical protocol)
   * and the same `(stack, id)` byte-stable sort, so a polyglot run with
   * two stacks declaring the same bare surface id keeps both rows in a
   * deterministic order rather than collapsing them.
   */
  documentationSurfacesInstantiated: Array<{
    stack: string;
    id: string;
    templateText: string;
    triggerEvidence: { scopeMatched: string[]; keywordsHit: string[] };
    appliesToFiles: string[];
  }>;
  evaluatorAdditionalChecks: Array<{
    command: string;
    on_failure: string;
    tier: string;
  }>;
}
