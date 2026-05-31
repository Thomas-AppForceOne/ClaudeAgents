/**
 * Decoy source for the `command-grep-missing-string` decoy.
 *
 * The faked finding's reproductionCommand searches this file for the literal
 * token `eval(` — that token is not present, so grep exits 1 and the
 * reproduction-gate drops the finding. The file is otherwise an innocuous
 * pure-function module.
 */
export function safeAdd(a: number, b: number): number {
  return a + b;
}

export function safeMul(a: number, b: number): number {
  return a * b;
}
