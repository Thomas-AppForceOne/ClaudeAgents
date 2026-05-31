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
/**
 * Pure addition of two numbers; part of the decoy module's innocuous content.
 *
 * @param a left operand.
 * @param b right operand.
 * @returns the sum of `a` and `b`.
 */
export function safeAdd(a: number, b: number): number {
  return a + b;
}

/**
 * Pure multiplication of two numbers; part of the decoy module's innocuous
 * content. Present so the decoy module exports more than one symbol — the
 * faked finding does not cite it.
 *
 * @param a left operand.
 * @param b right operand.
 * @returns the product of `a` and `b`.
 */
export function safeMul(a: number, b: number): number {
  return a * b;
}
