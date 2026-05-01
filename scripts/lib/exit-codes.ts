/**
 * Exit codes shared by every R4 maintainer script.
 *
 * The set is deliberately narrow — maintainer scripts do not surface F2
 * structured errors the way the `gan` CLI does (R3 owns that mapping).
 * They only need to signal:
 *
 *   - `SUCCESS` (0): the script ran and reported clean.
 *   - `FAILURE` (1): the script ran but found one or more violations.
 *   - `BAD_ARGS` (64): the caller invoked the script incorrectly
 *     (unknown flag, missing argument value, etc.).
 *
 * Future R4 sprints (`publish-schemas`, `evaluator-pipeline-check`,
 * `pair-names`, `lint-no-stack-leak`) re-use this same map.
 */
export const SCRIPT_EXIT = {
  SUCCESS: 0,
  FAILURE: 1,
  BAD_ARGS: 64,
} as const;

export type ScriptExit = (typeof SCRIPT_EXIT)[keyof typeof SCRIPT_EXIT];
