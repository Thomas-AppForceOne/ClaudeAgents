

/**
 * Shared type vocabulary for the evaluator-core planning layer.
 *
 * This module owns the data shapes that flow through the plan builder: the
 * raw resolved-config view ({@link EvaluatorCoreSnapshot}), the sprint/worktree
 * inputs ({@link SprintPlan}, {@link WorktreeState}), and the deterministic
 * output ({@link EvaluatorPlan}). It declares types only — no runtime logic —
 * so it can be imported by every builder without creating import cycles.
 *
 * Two structural conventions hold across these shapes and are stated once
 * here rather than on each field:
 * - The `absenceSignal` triad (`'silent' | 'warning' | 'blockingConcern'`)
 *   encodes how the evaluator should react when a configured command is
 *   missing at run time: stay quiet, surface a warning, or raise a blocking
 *   concern. It is data describing intent, never an action taken here.
 * - Every array the builders emit into {@link EvaluatorPlan} is sorted
 *   deterministically (locale-aware, case-sensitive) so byte-identical inputs
 *   yield a byte-identical plan; the snapshot's input arrays carry no such
 *   guarantee.
 */

/**
 * An audit command a stack contributes (e.g. `npm audit`).
 *
 * @property command the shell command to run for the audit.
 * @property absenceSignal how the evaluator reacts when this command is not
 *   present/runnable (see the module note for the triad's meaning).
 * @property absenceMessage optional human-readable text to show alongside the
 *   absence signal; omitted when the stack supplies no custom wording.
 */
export interface AuditCmd {
  command: string;
  absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  absenceMessage?: string;
}

/**
 * A documentation-lint command a stack contributes.
 *
 * @property command the doc-lint command to run.
 * @property absenceSignal how the evaluator reacts when the command is missing.
 * @property absenceMessage optional custom wording for the absence signal.
 * @property severity weight of a doc-lint finding: `blocker` fails the gate,
 *   `warning` is surfaced non-fatally, `advisory` is informational only.
 * @property baseline whether findings are measured as a `delta` against a
 *   prior baseline (only newly-introduced issues count) or in `absolute`
 *   terms (every issue counts). Optional; the builder defaults it to `delta`.
 */
export interface DocLintCmd {
  command: string;
  absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  absenceMessage?: string;
  severity: 'blocker' | 'warning' | 'advisory';
  baseline?: 'delta' | 'absolute';
}

/**
 * A security review prompt ("surface") a stack can contribute, instantiated
 * against the changed files when its triggers match.
 *
 * @property id stack-local identifier; qualified as `<stack>.<id>` once
 *   instantiated and checked by {@link isKnownSurfaceId}.
 * @property template the prompt/checklist text emitted verbatim when the
 *   surface fires.
 * @property triggers optional gating conditions; when absent the surface
 *   applies to every file in the stack's scope.
 * @property triggers.keywords substrings that must appear in a candidate
 *   file's contents for the surface to fire on it.
 * @property triggers.scope globs narrowing which stack-scoped files are
 *   candidates before the keyword test.
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
 * A documentation review prompt ("surface") a stack can contribute. Same
 * shape and trigger semantics as {@link SecuritySurface}; kept as a distinct
 * type so the two surface families stay independently typed at call sites.
 *
 * @property id stack-local identifier.
 * @property template the prompt text emitted verbatim when the surface fires.
 * @property triggers optional gating conditions (see {@link SecuritySurface}).
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
 * The resolved-config view the plan builder consumes — the raw, unsorted
 * input from which every {@link EvaluatorPlan} field is derived. Callers
 * supply it as-is; the builders never mutate it.
 *
 * @property activeStacks every stack in effect for this run, each carrying
 *   its scope globs and the optional commands/surfaces it contributes. Order
 *   is whatever resolution produced; the builders re-sort, so callers need not.
 * @property activeStacks[].name stack identifier, used as the sort key and as
 *   the `stack` field on emitted rows.
 * @property activeStacks[].scope globs delimiting which worktree files the
 *   stack governs.
 * @property activeStacks[].secretsGlob file extensions (without leading dot)
 *   to scan for secrets; absent or empty means the stack opts out.
 * @property activeStacks[].buildCmd/testCmd/lintCmd optional commands; the
 *   first non-empty value across stacks (in sorted order) wins (see
 *   {@link EvaluatorPlan.buildTestLint}).
 * @property mergedSplicePoints config splice points merged across tiers; only
 *   `evaluator.additionalChecks` is consumed here.
 * @property mergedSplicePoints.'evaluator.additionalChecks' extra evaluator
 *   checks contributed via splice; absent when none were configured.
 */
export interface EvaluatorCoreSnapshot {

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

  mergedSplicePoints: {
    'evaluator.additionalChecks'?: Array<{
      command: string;
      on_failure: string;
      tier: string;
    }>;
  };
}

/**
 * The sprint's intent, used to scope surface instantiation.
 *
 * @property affectedFiles repo-relative paths the sprint plans to touch; the
 *   candidate set against which security/documentation surfaces are matched.
 * @property criteria the sprint's acceptance criteria; carried for downstream
 *   consumers and not read by the plan builder itself.
 */
export interface SprintPlan {

  affectedFiles: string[];

  criteria: Array<{ id: string; description: string }>;
}

/**
 * A snapshot of the worktree the evaluator runs against.
 *
 * @property files every repo-relative path present in the worktree; the
 *   universe the secrets scan globs against.
 * @property fileContents optional map from path to file contents, consulted
 *   for keyword-triggered surfaces. A file absent from this map (or present
 *   with non-string contents) simply cannot satisfy a keyword trigger; it is
 *   not an error.
 */
export interface WorktreeState {

  files: string[];

  fileContents?: Record<string, string>;
}

/**
 * The deterministic evaluator plan — the assembled output of
 * {@link buildEvaluatorPlan}. Every array field is sorted (see the module
 * note) so equal inputs serialise identically; callers can diff two plans
 * byte-for-byte to detect a change in resolved config.
 *
 * @property activeStacks the active stacks reduced to `{ name, scope }`, sorted
 *   by name.
 * @property secretsScans one row per (stack, secrets-extension) whose glob
 *   matched at least one in-scope worktree file, listing those files.
 * @property auditCommands the audit command per stack that declares one,
 *   sorted by stack.
 * @property docLintInvocations the doc-lint command per stack that declares
 *   one, with its scope, severity, resolved baseline, and absence signal.
 * @property buildTestLint the first non-empty build/test/lint command found
 *   when stacks are visited in name order (each chosen independently).
 * @property securitySurfacesInstantiated security surfaces whose triggers
 *   fired, with the matching files and trigger evidence.
 * @property documentationSurfacesInstantiated documentation surfaces whose
 *   triggers fired, same shape as the security rows.
 * @property evaluatorAdditionalChecks extra checks contributed via the
 *   `evaluator.additionalChecks` splice point, in their merged order.
 */
export interface EvaluatorPlan {
  activeStacks: Array<{ name: string; scope: string[] }>;
  secretsScans: Array<{ stack: string; extension: string; files: string[] }>;
  auditCommands: Array<{
    stack: string;
    command: string;
    absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  }>;

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
