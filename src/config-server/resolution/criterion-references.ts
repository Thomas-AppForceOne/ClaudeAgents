/**
 * Pure-function backbone for the contract-proposer's pre-flight name-resolution
 * pass. The proposer authors `criteria[].description` as free prose; this
 * module parses every backtick-quoted shell-script reference from each
 * description and resolves it against a script map sourced from the run's
 * base-commit `package.json`.
 *
 * Why a pure-function backbone separate from the MCP wrapper. The wrapper has
 * to read the base-commit `package.json` from disk (a subprocess against the
 * local git worktree); that side effect is intentionally NOT in the backbone
 * so the backbone is deterministic and unit-testable against fixture inputs.
 * The MCP wrapper is the boundary between the side-effecting read and the pure
 * parse + resolve pass; the dual-callable surface convention places both
 * behind the same library function, never a second implementation.
 *
 * Why this surface lives under `src/config-server/resolution/`. The directory
 * already houses the resolution pipeline the configuration API runs at load
 * time (active stacks, overlay cascade, stack file resolution). The criterion-
 * reference resolver fits that family — it answers "does this name resolve at
 * the run's base commit?" the same way the cascade answers "what does this
 * splice point resolve to after the merge?" — pure, side-effect-free, dataset-
 * driven. The MCP tool wrapper sits in the sibling `tools/` directory exactly
 * like every other tool that wraps a resolution-tier library function.
 *
 * Scope of v1. The backbone covers `npm run X` script-name resolution only.
 * Backtick tokens that are not `npm run X` (plain file paths, exported symbol
 * names, bare commands) are deliberately ignored — they produce no records and
 * do not gate the draft. File paths and exported symbols carry very different
 * cost / precision profiles and are out of scope for v1 per the introducing
 * spec.
 */

/**
 * The kind of reference resolved by this module. Today the only kind is
 * `"npmScript"` (an `npm run X` invocation embedded in a criterion
 * description); future versions of the pre-flight may add `"filePath"` or
 * `"exportedSymbol"`. Treated as a closed string union so a downstream
 * consumer can exhaustively switch on `kind` without breaking on an unknown
 * value the v1 surface never produces.
 */
export type CriterionReferenceKind = 'npmScript';

/**
 * One resolved reference record returned by {@link validateCriterionReferences}.
 *
 * @property name the resolved bare reference — for an `npm run X` token, the
 *   script name `X` with any preceding flags (`-s`, `--silent`) stripped. The
 *   value is suitable for direct lookup against the `package.json` `scripts`
 *   map.
 * @property kind the closed `CriterionReferenceKind`. Today always
 *   `"npmScript"`.
 * @property resolved `true` when the reference resolves against the supplied
 *   script map; `false` otherwise. For an `npmScript` reference, resolution is
 *   `true` iff `name` appears as a key in the `package.json` `scripts` object.
 * @property hint when `resolved === false`, the closest matching script name
 *   in the supplied script map by Levenshtein distance (≤ 3, ties broken by
 *   lexicographic order). Omitted when no script is within distance 3 or when
 *   `resolved === true`.
 * @property criterionName the `name` of the criterion the reference was parsed
 *   out of, surfaced so the caller can route the record back to a specific
 *   criterion when reporting an unresolved reference.
 * @property source the verbatim backtick-quoted token the reference was
 *   parsed out of (e.g. `` `npm run -s test-house-rules` ``), surfaced so the
 *   caller can quote the offending span in a remediation message.
 */
export interface CriterionReferenceRecord {
  name: string;
  kind: CriterionReferenceKind;
  resolved: boolean;
  hint?: string;
  criterionName: string;
  source: string;
}

/**
 * The minimal shape this module reads from a contract draft. The proposer's
 * draft is a free-form object with many other fields; the backbone reads only
 * `criteria[].name` and `criteria[].description`. A wider type would couple
 * the resolver to the proposer's draft schema unnecessarily.
 *
 * @property criteria an array of `{name, description}` records (extra fields
 *   tolerated by the index signature so a real draft passes through).
 */
export interface ContractDraftLike {
  criteria: ReadonlyArray<{ name: string; description: string; [extra: string]: unknown }>;
  [extra: string]: unknown;
}

/**
 * Backtick-quoted token matcher. The matcher recognises a single pair of
 * backticks (`` ` … ` ``) and captures the inner span. The non-greedy `[^`]*`
 * pattern is deliberate — backtick spans inside a description are short
 * shell-style snippets and never nest backticks; allowing a greedy match
 * would conflate two adjacent tokens on the same line.
 *
 * The matcher is scoped to a single line of input per call because the
 * walker resets `lastIndex` per description; this keeps the global flag's
 * stateful position from bleeding across descriptions in the contract draft.
 */
const BACKTICK_TOKEN_REGEX = /`([^`]+)`/g;

/**
 * Recognises an `npm run` invocation inside a backtick-quoted token. The
 * inner span must start with `npm run` (with optional surrounding whitespace),
 * tolerate any number of preceding short flags (`-s`, `--silent`), and end
 * with a script-name matching `[A-Za-z0-9_:-]+`. The script-name set mirrors
 * the npm convention for script keys; anything outside that set surfaces as
 * a non-match and the token is ignored.
 *
 * The flag-tolerance segment (`(?:\s+-\S+)*`) is what lets the matcher
 * accept the proposer's typical `` `npm run -s X` `` form without forcing a
 * second regex; the flag-stripping happens in the matcher itself rather than
 * in a post-processing step so the backbone has one source of truth for
 * "what is the bare script name".
 */
const NPM_RUN_TOKEN_REGEX = /^\s*npm\s+run(?:\s+-\S+)*\s+([A-Za-z0-9_:-]+)\s*$/;

/**
 * Hint distance ceiling. A candidate script whose Levenshtein distance from
 * the unresolved name exceeds this value is not surfaced as a hint. The
 * value of 3 catches single-letter typos, swapped-letter typos, and missing
 * one-syllable prefixes / suffixes (the observed pattern in the originating
 * defect: `test-house-rules` versus `house-rules` is distance 5, so it does
 * NOT surface as a hint — a deliberate conservative choice so the hint never
 * proposes a substitution far enough from the typo to be wrong). Tightening
 * to 2 would mute most real typos; loosening to 4+ would surface spurious
 * candidates.
 */
const HINT_MAX_DISTANCE = 3;

/**
 * Parse every backtick-quoted token from `description` and return the inner
 * span of each. Pure; bounded by the description length. The lastIndex reset
 * is required because the regex is global and the matcher is re-used across
 * descriptions; a stale `lastIndex` between descriptions would silently skip
 * the first token on the next description.
 *
 * @param description a `criteria[].description` string.
 * @returns the ordered list of `{token, source}` pairs — `token` is the inner
 *   span (no surrounding backticks), `source` the full backtick-quoted span
 *   the caller may quote verbatim in a remediation message.
 */
function extractBacktickTokens(description: string): Array<{ token: string; source: string }> {
  const out: Array<{ token: string; source: string }> = [];
  BACKTICK_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BACKTICK_TOKEN_REGEX.exec(description)) !== null) {
    const inner = match[1];
    if (inner === undefined) continue;
    out.push({ token: inner, source: match[0] });
  }
  return out;
}

/**
 * If `token` matches the `npm run [flags] <script-name>` shape, return the
 * bare script name; otherwise return `null`. Pure.
 *
 * The matcher tolerates an optional `-s` (silent) flag and any other short
 * flag preceding the script name, so the proposer's typical `npm run -s X`
 * form normalises to the same bare script name as `npm run X` — both are
 * resolved against the same script-map key.
 *
 * @param token the inner span of a backtick-quoted token.
 * @returns the bare script name, or `null` when the token is not an
 *   `npm run X` invocation (the matcher silently ignores plain paths, plain
 *   symbol names, and other shell tokens — they are out of v1 scope).
 */
function matchNpmRunScript(token: string): string | null {
  const m = token.match(NPM_RUN_TOKEN_REGEX);
  if (m === null) return null;
  const captured = m[1];
  return captured ?? null;
}

/**
 * Compute the Levenshtein edit distance between two strings. Pure; allocates
 * a single `(a.length + 1) × (b.length + 1)` integer matrix.
 *
 * Used only by the hint selector below. The implementation is a textbook
 * dynamic-programming version of the algorithm — no novel optimisation, no
 * external dependency — because the input domain is bounded (script names
 * are short, the script map carries tens of entries at most) and the cost of
 * any clever optimisation would dwarf the saved work.
 *
 * @param a the first string.
 * @param b the second string.
 * @returns the minimum number of single-character insertions, deletions, or
 *   substitutions to transform `a` into `b`.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  // The matrix is allocated as a flat array so each cell access is a single
  // index computation rather than a two-step array-of-arrays lookup; this is
  // ergonomic, not a perf optimisation.
  const dp = new Array<number>(rows * cols);
  for (let i = 0; i < rows; i += 1) dp[i * cols] = i;
  for (let j = 0; j < cols; j += 1) dp[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const above = dp[(i - 1) * cols + j]!;
      const left = dp[i * cols + (j - 1)]!;
      const diag = dp[(i - 1) * cols + (j - 1)]!;
      let best = above + 1;
      if (left + 1 < best) best = left + 1;
      if (diag + cost < best) best = diag + cost;
      dp[i * cols + j] = best;
    }
  }
  return dp[rows * cols - 1]!;
}

/**
 * Pick the closest matching script name in `scriptNames` by Levenshtein
 * distance, returning `null` when no candidate sits within
 * {@link HINT_MAX_DISTANCE}. Ties are broken by lexicographic ordering of
 * the script name so the choice is deterministic across runs.
 *
 * @param target the unresolved name to find a hint for.
 * @param scriptNames the keys of the `package.json` `scripts` map.
 * @returns the chosen hint, or `null` when nothing is close enough.
 */
function chooseHint(target: string, scriptNames: readonly string[]): string | null {
  let bestName: string | null = null;
  let bestDistance = HINT_MAX_DISTANCE + 1;
  // Sort candidates so the tie-break is locale-insensitive and deterministic.
  const sorted = scriptNames.slice().sort();
  for (const candidate of sorted) {
    const d = levenshtein(target, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      bestName = candidate;
    }
  }
  if (bestName === null || bestDistance > HINT_MAX_DISTANCE) return null;
  return bestName;
}

/**
 * Inputs to {@link validateCriterionReferences}.
 *
 * @property draft the contract-proposer's draft, conforming to
 *   {@link ContractDraftLike} (the resolver reads only `criteria[].name` and
 *   `criteria[].description`; extra fields pass through).
 * @property packageJsonContents the contents of the run's base-commit
 *   `package.json` as a UTF-8 JSON string. The caller (an MCP wrapper or a
 *   direct library caller) has already read the file from disk; the backbone
 *   does not perform any I/O of its own.
 */
export interface ValidateCriterionReferencesInput {
  draft: ContractDraftLike;
  packageJsonContents: string;
}

/**
 * Outputs of {@link validateCriterionReferences}.
 *
 * @property records every parsed `npm run X` token in source order: each entry
 *   carries the resolved name, the kind discriminator, the boolean resolution
 *   flag, an optional `hint`, the `criterionName` the reference came from,
 *   and the verbatim backtick-quoted `source` token.
 * @property unresolvedCount the count of records with `resolved === false`,
 *   pre-computed so a downstream consumer can short-circuit on the headline
 *   "are there any unresolved references?" question without re-walking the
 *   records array.
 */
export interface ValidateCriterionReferencesResult {
  records: CriterionReferenceRecord[];
  unresolvedCount: number;
}

/**
 * The pre-flight name-resolution pass.
 *
 * Walks every `criteria[].description` in the draft, extracts every backtick-
 * quoted token, ignores tokens that are not `npm run X` invocations (out of
 * v1 scope), and for each surviving token returns a structured record stating
 * whether the script name resolves against the supplied `package.json`'s
 * `scripts` map. The function is pure — it never reads disk, never spawns a
 * subprocess, and never throws on a benign input (a malformed `package.json`
 * surfaces as zero recognised script names, so every token resolves to
 * `false`; a draft with no criteria yields an empty record array).
 *
 * Failure modes:
 * - `packageJsonContents` is not valid JSON. The backbone treats this as
 *   "no scripts defined" rather than throwing, so a downstream caller that
 *   accidentally hands the function a non-JSON blob (a CI step that read a
 *   directory listing) reports every token as unresolved — a noisy result,
 *   but bounded and safe. A caller that wants to distinguish "no scripts"
 *   from "malformed JSON" can pre-validate the string before calling.
 * - `package.json` parses but has no `scripts` object, or has one that is not
 *   a plain object. Same handling — treat as "no scripts defined".
 *
 * Caller invariants:
 * - `draft` must carry an array `criteria` field; a draft missing the field
 *   yields an empty record array (no throw).
 * - Each criterion's `name` and `description` are read as strings; entries
 *   with non-string values are skipped silently rather than throwing, so a
 *   partially-valid draft still produces useful records for its valid
 *   criteria.
 *
 * Side effects: none. The function does not log, write to disk, spawn, or
 * mutate its inputs.
 *
 * @param input the structured input ({@link ValidateCriterionReferencesInput}).
 * @returns the structured result ({@link ValidateCriterionReferencesResult}).
 */
export function validateCriterionReferences(
  input: ValidateCriterionReferencesInput,
): ValidateCriterionReferencesResult {
  const { draft, packageJsonContents } = input;

  // Defensive parse: a malformed `package.json` collapses to "no scripts".
  // Resolution against an empty script map then surfaces every reference as
  // unresolved, which is a noisy but bounded result the caller can act on.
  let scriptMap: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(packageJsonContents) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const raw = (parsed as { scripts?: unknown }).scripts;
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        scriptMap = raw as Record<string, unknown>;
      }
    }
  } catch {
    // Intentional: the failure mode is documented above; leave scriptMap empty.
  }
  const scriptNames = Object.keys(scriptMap);

  const records: CriterionReferenceRecord[] = [];
  const criteria = Array.isArray(draft.criteria) ? draft.criteria : [];
  for (const criterion of criteria) {
    if (typeof criterion !== 'object' || criterion === null) continue;
    const c = criterion as { name?: unknown; description?: unknown };
    const criterionName = typeof c.name === 'string' ? c.name : '';
    const description = typeof c.description === 'string' ? c.description : '';
    if (description.length === 0) continue;

    for (const { token, source } of extractBacktickTokens(description)) {
      const scriptName = matchNpmRunScript(token);
      if (scriptName === null) {
        // Non-`npm run` backtick tokens are out of v1 scope. They are
        // recognised by the extractor but ignored here; the proposer is not
        // obliged to act on them and they are not surfaced as records.
        continue;
      }
      const resolved = Object.prototype.hasOwnProperty.call(scriptMap, scriptName);
      const record: CriterionReferenceRecord = {
        name: scriptName,
        kind: 'npmScript',
        resolved,
        criterionName,
        source,
      };
      if (!resolved) {
        const hint = chooseHint(scriptName, scriptNames);
        if (hint !== null) {
          record.hint = hint;
        }
      }
      records.push(record);
    }
  }

  let unresolvedCount = 0;
  for (const r of records) {
    if (!r.resolved) unresolvedCount += 1;
  }

  return { records, unresolvedCount };
}
