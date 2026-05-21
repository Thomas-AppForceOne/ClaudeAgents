/**
 * Shared user-home resolution for the user-tier path
 * `~/.claude/gan/stacks/<name>.md` (per C5).
 *
 * Used by every `gan stacks` subcommand that can target the user tier
 * (`new`, `customize`, `reset`). Resolution order — `GAN_USER_HOME`
 * (test injection) → `HOME` → `USERPROFILE` (Windows) — is the single
 * canonical convention; do not redefine it per command. Returns `null`
 * when none is set so callers can emit a structured `MalformedInput`
 * rather than guessing a path.
 */
export function resolveUserHome(): string | null {
  const v = process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
