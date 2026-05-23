/**
 * Shared process exit codes for the `scripts/` CLI entrypoints.
 *
 * Every script returns one of these from its `main` and feeds it to
 * `process.exit`, so the numbers are a contract with CI and shell callers,
 * not an internal detail. They are chosen to compose cleanly with the shell:
 * `0`/`1` are the conventional success/failure pair, and `64` is the BSD
 * `sysexits.h` `EX_USAGE` code — reserving it for argument errors lets a
 * caller distinguish "the check found problems" (`1`) from "you invoked me
 * wrong" (`64`) without parsing stderr.
 */
export const SCRIPT_EXIT = {
  // Clean run: the check passed (or a write/repair mode completed with no drift).
  SUCCESS: 0,
  // The check ran but found at least one reportable failure.
  FAILURE: 1,
  // Usage error (unknown flag, unexpected positional) — EX_USAGE from sysexits.h.
  BAD_ARGS: 64,
} as const;

/**
 * The union of the literal exit-code values in {@link SCRIPT_EXIT}
 * (i.e. `0 | 1 | 64`). Derived from the const object so the type can never
 * drift from the values it documents; a script's `main` is typed to return
 * this so a stray numeric code is a compile error.
 */
export type ScriptExit = (typeof SCRIPT_EXIT)[keyof typeof SCRIPT_EXIT];
