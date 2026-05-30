/**
 * Evaluator-core MCP tool handler — a thin wrapper around the shipped
 * deterministic evaluator-plan builder.
 *
 * One entry point lives here: {@link buildEvaluatorPlanTool}. It exists to
 * make the evaluator-core library callable from the MCP transport surface
 * without introducing a second plan-building implementation; the
 * dual-callable rule applies — a tool import and a direct
 * `src/agents/evaluator-core` import resolve to the same underlying
 * function, so the catalog tool and a direct library call return
 * byte-equal plans for the same inputs.
 *
 * Why a thin wrapper rather than a re-implementation: the evaluator-core
 * library was shipped before this MCP surface existed and exposes a
 * three-positional-argument signature
 * (`buildEvaluatorPlan(snapshot, sprintPlan, worktreeState)`). MCP carries
 * one structured input object per call, so the handler destructures the
 * three named fields and forwards them positionally — no field renaming,
 * no defaulting, no shape transformation. Keeping the translation layer
 * empty preserves the single-implementation rule the parity tests pin.
 *
 * Why the handler returns data only and never executes: the plan is a
 * specification of what the evaluator should check (audit commands,
 * doc-lint invocations, build/test/lint commands, security and
 * documentation surfaces, secrets scans). The agent runs those commands
 * under the existing PreToolUse confinement and trust gate; the tool
 * itself is pure in-memory assembly and emits no subprocess, no
 * filesystem write, no network call. The static-scan and runtime
 * no-side-effect tests in the slice-4 test file pin that property as a
 * regression guard mirroring earlier slices.
 */

import { buildEvaluatorPlan as libraryBuildEvaluatorPlan } from '../../agents/evaluator-core/index.js';
import type {
  EvaluatorCoreSnapshot,
  EvaluatorPlan,
  SprintPlan,
  WorktreeState,
} from '../../agents/evaluator-core/index.js';

/**
 * Input to {@link buildEvaluatorPlanTool}.
 *
 * The three fields are the same three positional arguments the library
 * function accepts, wrapped in a single object so the MCP transport can
 * carry them as one structured payload.
 *
 * @property snapshot the resolved-config view (active stacks with their
 *   scope/command/surface declarations plus merged splice points). The
 *   library re-sorts on output; the snapshot's input arrays carry no
 *   ordering guarantee.
 * @property sprintPlan the sprint's affected-files list (used to scope
 *   surface instantiation) and acceptance criteria (carried for
 *   downstream consumers and not read by the plan builder itself).
 * @property worktreeState the worktree's file listing and the optional
 *   per-file contents map; a file absent from `fileContents` simply
 *   cannot satisfy a keyword trigger (it is not an error).
 */
export interface BuildEvaluatorPlanToolInput {
  snapshot: EvaluatorCoreSnapshot;
  sprintPlan: SprintPlan;
  worktreeState: WorktreeState;
}

/**
 * Build the deterministic evaluator plan from a snapshot, sprint plan,
 * and worktree state.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryBuildEvaluatorPlan} from `src/agents/evaluator-core`.
 * The wrapper destructures the three named fields and forwards them
 * positionally; it adds no defaults, no shape conversion, and no field
 * renaming. The returned plan is whatever the library produced — every
 * field (`activeStacks`, `secretsScans`, `auditCommands`,
 * `docLintInvocations`, `buildTestLint`, `securitySurfacesInstantiated`,
 * `documentationSurfacesInstantiated`, `evaluatorAdditionalChecks`)
 * is the library's own output, byte-for-byte.
 *
 * @param input the {@link BuildEvaluatorPlanToolInput} the MCP transport
 *   carries as one structured object.
 * @returns the shipped {@link EvaluatorPlan}. Pure; never throws on its
 *   own (any throw originates inside a library sub-builder), and
 *   produces no side effect — no subprocess, no filesystem write, no
 *   network call.
 */
export function buildEvaluatorPlanTool(input: BuildEvaluatorPlanToolInput): EvaluatorPlan {
  const { snapshot, sprintPlan, worktreeState } = input;
  return libraryBuildEvaluatorPlan(snapshot, sprintPlan, worktreeState);
}
