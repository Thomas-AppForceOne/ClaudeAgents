/**
 * Parser for the framework-version banner the confinement-hook template stamps
 * into every hook the framework writes. The banner is a single header line of
 * the form
 *
 *   # Source of truth: ClaudeAgents framework, version <semver>.
 *
 * and the parser projects it into a per-tier verdict (`matches` / `lags` /
 * `ahead`) plus the contract revision the parsed version implies (`F1`, `F7`,
 * or `unknown`). The contract revision drives the human-readable label on
 * `gan hooks status`; the per-tier verdict drives `bannerVerdict` on the JSON
 * surface.
 *
 * Design choices stated once at the module level so they do not repeat on
 * every export:
 * - The banner read is advisory; the behaviour probe (in
 *   `confine-hook-probe.ts`) wins on disagreement in every direction
 *   (`matches`, `lags`, or `ahead`) because the probe tests the observable
 *   contract while the banner is metadata an operator can hand-edit.
 * - The parser never throws. Empty input, missing banner, and unparseable
 *   semver all collapse to the `unknown` verdict — a binary or non-bash file
 *   carrying the banner text by coincidence is therefore safe to feed in.
 * - The pivot table is encoded as a binary-searchable `const` so a future
 *   hook-contract change is a one-line addition at the right `minVersion`,
 *   without touching call sites or growing a registry.
 */

/**
 * The closed set of contract revisions the banner heuristic recognises.
 * `F1` is the pre-F7 zone construction the original H1 hook shipped;
 * `F7` is the GAN_RUN_DIR-aware zones the framework writes today; `unknown`
 * fires when no banner could be parsed.
 */
export type ContractRevision = 'F1' | 'F7' | 'unknown';

/**
 * The per-tier banner verdict that lands on the JSON surface's `bannerVerdict`
 * field. `matches` / `lags` / `ahead` fire only when a banner parsed and the
 * parsed version was compared against the framework's installed version;
 * `absent` fires when no banner line was found in the file; `unparseable`
 * fires when a banner line matched the regex but its semver did not parse.
 */
export type BannerVerdict = 'matches' | 'lags' | 'ahead' | 'absent' | 'unparseable';

/**
 * One row in the contract-revision pivot table.
 *
 * @property minVersion the lowest framework semver (major.minor.patch only,
 *   no prerelease / build-metadata suffix) at which the row's contract
 *   revision applies. Binary search picks the highest row whose `minVersion`
 *   is `<=` the parsed version, so adjacent rows define a half-open range
 *   `[this.minVersion, nextRow.minVersion)`.
 * @property contractRevision the revision label the row pins.
 */
export interface ContractRevisionPivot {
  readonly minVersion: string;
  readonly contractRevision: ContractRevision;
}

/**
 * The contract-revision pivot table. F7's actual ship version is `0.1.0`
 * (the framework version that shipped the GAN_RUN_DIR-aware template);
 * everything below it is the F1 hook contract the original H1 spec wrote.
 * The `0.0.0` floor is the canonical "any parseable version" anchor — a
 * parsed `0.0.x` lands on `F1` rather than collapsing to `unknown`. A future
 * hook-contract change appends a row at the relevant `minVersion`; no
 * schema, registry, or data file edit is required.
 */
export const CONTRACT_REVISION_PIVOTS: readonly ContractRevisionPivot[] = [
  // F1 anchor: the pre-F7 hook contract — `<project>/.gan-state/` zones, no
  // GAN_RUN_DIR awareness. Floor at 0.0.0 so any parseable banner version
  // resolves to a concrete revision rather than `unknown`.
  { minVersion: '0.0.0', contractRevision: 'F1' },
  // F7 anchor: the GAN_RUN_DIR-aware hook contract first shipped in the
  // framework's 0.1.0 release. Hooks authored against this revision honour
  // both GAN_WORKTREE and GAN_RUN_DIR as allowed zones.
  { minVersion: '0.1.0', contractRevision: 'F7' },
] as const;

/**
 * The shape returned by {@link parseConfineHookBanner}.
 *
 * @property version the raw version string the banner declared (preserving
 *   any prerelease / build-metadata suffix the operator can see), or `null`
 *   when no banner was found or its semver did not parse. The JSON surface
 *   on `gan hooks status` emits this verbatim — never the string `"unknown"`.
 * @property contractRevision the revision the parsed version (after stripping
 *   prerelease / build-metadata suffixes) maps to via
 *   {@link CONTRACT_REVISION_PIVOTS}; `unknown` when the version is absent or
 *   unparseable.
 */
export interface ParsedBanner {
  version: string | null;
  contractRevision: ContractRevision;
}

// Pin the banner regex to a module constant so the call sites and tests
// reference one literal: the leading `# Source of truth: ClaudeAgents
// framework, version <semver>.` shape the framework's template stamps. The
// `m` flag matches at any line start in a multi-line file; first match wins
// (a multi-banner file takes the first occurrence). The trailing `\s*` after
// the period tolerates a trailing CR on Windows-edited files.
const BANNER_REGEX = /^# Source of truth: ClaudeAgents framework, version (\S+)\.\s*$/m;

// Major.minor.patch core extractor. Splits semver into its three integer
// components and the optional prerelease / build-metadata suffix. Tolerates
// `1.4.0-rc.1`, `1.4.0+sha.abc`, and combinations; rejects anything that
// does not look like three dot-separated non-negative integers.
const SEMVER_CORE_REGEX = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+].*)?$/;

/**
 * Parse the framework-version banner out of a hook file's contents.
 *
 * The function is the single source of truth for the banner read: both the
 * CLI status command and the MCP probe wrapper call it. It is safe to feed
 * any byte sequence — empty input, binary content, multi-megabyte text —
 * because the regex only fires on a well-shaped header line and the pivot
 * lookup walks a small in-memory table.
 *
 * @param content the full hook file contents as a UTF-8 string.
 * @returns a {@link ParsedBanner} carrying the matched version (or `null`)
 *   and the derived contract revision (`F1`, `F7`, or `unknown`).
 *   Failure modes: any input that does not contain a matching banner line,
 *   or whose matched version does not parse as semver, returns
 *   `{ version: null, contractRevision: 'unknown' }`. The function never
 *   throws — a parse failure is a verdict, not an exception. No side effects.
 */
export function parseConfineHookBanner(content: string): ParsedBanner {
  // Defensive guard: the regex itself tolerates an empty string, but the
  // explicit short-circuit is cheaper and reads as the intended contract.
  if (typeof content !== 'string' || content.length === 0) {
    return { version: null, contractRevision: 'unknown' };
  }
  const match = BANNER_REGEX.exec(content);
  if (match === null) {
    return { version: null, contractRevision: 'unknown' };
  }
  const rawVersion = match[1]!;
  const core = SEMVER_CORE_REGEX.exec(rawVersion);
  if (core === null) {
    // Banner found, semver unparseable: surface the raw string so an
    // operator can see what the file actually carries, but the contract
    // revision collapses to `unknown` rather than guessing a pivot.
    return { version: rawVersion, contractRevision: 'unknown' };
  }
  const major = Number.parseInt(core[1]!, 10);
  const minor = Number.parseInt(core[2]!, 10);
  const patch = Number.parseInt(core[3]!, 10);
  const contractRevision = lookupRevision(major, minor, patch);
  return { version: rawVersion, contractRevision };
}

/**
 * Compare a parsed banner version against the framework's installed version
 * and project the comparison into the per-tier verdict the JSON surface
 * emits on `bannerVerdict`.
 *
 * @param parsedVersion the raw version string the banner declared
 *   (`null` when no banner parsed). A `null` parsed version means the banner
 *   did not match at all — surfaced as `absent`. A non-null but unparseable
 *   semver — when the regex fired but the core extraction failed — is
 *   surfaced as `unparseable`.
 * @param installedVersion the framework's installed version (read from the
 *   package's `package.json`). When this is `null` the verdict collapses to
 *   `absent` for an absent banner or `unparseable` for an un-comparable one:
 *   without an installed anchor the matches / lags / ahead branches cannot
 *   fire.
 * @returns one of `'matches'`, `'lags'`, `'ahead'`, `'absent'`, or
 *   `'unparseable'`. Pure; no I/O; never throws.
 */
export function compareBanner(
  parsedVersion: string | null,
  installedVersion: string | null,
): BannerVerdict {
  if (parsedVersion === null) {
    return 'absent';
  }
  const parsedCore = SEMVER_CORE_REGEX.exec(parsedVersion);
  if (parsedCore === null) {
    return 'unparseable';
  }
  if (installedVersion === null) {
    // No installed anchor: report `unparseable` so the operator sees the
    // missing comparison without the surface lying about a match.
    return 'unparseable';
  }
  const installedCore = SEMVER_CORE_REGEX.exec(installedVersion);
  if (installedCore === null) {
    return 'unparseable';
  }
  const cmp = compareCores(
    [
      Number.parseInt(parsedCore[1]!, 10),
      Number.parseInt(parsedCore[2]!, 10),
      Number.parseInt(parsedCore[3]!, 10),
    ],
    [
      Number.parseInt(installedCore[1]!, 10),
      Number.parseInt(installedCore[2]!, 10),
      Number.parseInt(installedCore[3]!, 10),
    ],
  );
  if (cmp === 0) return 'matches';
  if (cmp < 0) return 'lags';
  return 'ahead';
}

// Look up the contract revision for a (major, minor, patch) triple via a
// binary search of CONTRACT_REVISION_PIVOTS. Picks the highest row whose
// `minVersion` is `<=` the input.
function lookupRevision(major: number, minor: number, patch: number): ContractRevision {
  const target: [number, number, number] = [major, minor, patch];
  let lo = 0;
  let hi = CONTRACT_REVISION_PIVOTS.length - 1;
  let bestIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pivot = CONTRACT_REVISION_PIVOTS[mid]!;
    const pivotCore = SEMVER_CORE_REGEX.exec(pivot.minVersion);
    // Defensive: a malformed pivot row would silently degrade to `unknown`,
    // but the table is a module-private const so this branch is unreachable
    // in normal operation. Returned explicitly so a future hand-edit that
    // breaks the table fails closed rather than silently mis-classifying.
    if (pivotCore === null) {
      return 'unknown';
    }
    const cmp = compareCores(target, [
      Number.parseInt(pivotCore[1]!, 10),
      Number.parseInt(pivotCore[2]!, 10),
      Number.parseInt(pivotCore[3]!, 10),
    ]);
    if (cmp >= 0) {
      bestIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestIndex < 0) {
    return 'unknown';
  }
  return CONTRACT_REVISION_PIVOTS[bestIndex]!.contractRevision;
}

// Three-way semver-core comparator: returns -1 / 0 / +1 for less / equal /
// greater. Each component is compared in order; the first non-equal pair
// determines the result. Inputs are non-negative integers.
function compareCores(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}
