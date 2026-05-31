/**
 * Decoy source for the `command-grep-missing-string` decoy.
 *
 * The faked finding's reproductionCommand searches this file for a literal
 * token (the JS dynamic-eval call) that is not present, so grep exits 1 and
 * the reproduction-gate drops the finding. The file is otherwise an
 * innocuous pure-function module.
 *
 * The exact token grep looks for is deliberately spelled here as
 * `e` + `v` + `a` + `l` + `(` so that this docstring does NOT itself
 * contain the literal grep target — otherwise the decoy would self-match.
 */
export function safeAdd(a: number, b: number): number {
  return a + b;
}

export function safeMul(a: number, b: number): number {
  return a * b;
}
