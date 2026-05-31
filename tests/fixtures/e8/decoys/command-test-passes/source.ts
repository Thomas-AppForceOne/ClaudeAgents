/**
 * Decoy source for the `command-test-passes` decoy.
 *
 * The faked finding claims `add(2,3)` returns 6; in fact it returns 5. The
 * reviewer's reproductionCommand `if (add(2,3) !== 5) process.exit(1)` will
 * therefore succeed (exit 0), proving the alleged defect does NOT manifest.
 * The reproduction-gate drops the finding.
 */
export function add(a: number, b: number): number {
  return a + b;
}
