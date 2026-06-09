/**
 * `src/hook-probe/` — neutral home for the confinement-hook
 * detection and migration helpers H3 introduces. The module is
 * deliberately tier-neutral: both `src/cli/commands/hooks-*.ts`
 * (the CLI surface) and `src/config-server/tools/confine-hook-
 * probe.ts` (the MCP tool wrapper exposed to the `/gan` skill-side
 * preflight) import from here, so the dependency graph stays
 * unidirectional `cli` and `config-server` → `hook-probe`. Without
 * this neutral home, the MCP tool would have to reach into the
 * `cli/lib/` tier, the first backwards-pointing edge in the
 * framework's layer graph.
 *
 * Surface:
 * - {@link runConfineHookProbe} — the load-bearing detector both
 *   the CLI status command and the skill-side preflight invoke.
 * - {@link parseConfineHookBanner} / {@link compareBanner} —
 *   advisory banner-derived metadata that the probe verdict
 *   supersedes on disagreement.
 * - {@link BACKUP_SIBLING_PREFIX} / {@link listBackupSiblings} —
 *   the migrate command's wire format for timestamped backups.
 * - {@link renderCurrentTemplate} / {@link
 *   readInstalledFrameworkVersion} — the single Node-side renderer
 *   `gan hooks migrate --replace` uses, byte-equivalent to what
 *   `install.sh` writes to the user-tier path.
 */

export {
  runConfineHookProbe,
  type RunConfineHookProbeInput,
  type RunConfineHookProbeResult,
  type ConfineProbeVerdict,
  type ConfineProbeSubReason,
} from './probe.js';

export {
  parseConfineHookBanner,
  compareBanner,
  bannerVerdictKind,
  CONTRACT_REVISION_PIVOTS,
  type ContractRevision,
  type BannerVerdict,
  type BannerVerdictKind,
  type ContractRevisionPivot,
  type ParsedBanner,
} from './banner.js';

export { BACKUP_SIBLING_PREFIX, listBackupSiblings } from './paths.js';

export {
  readInstalledFrameworkVersion,
  readInstalledFrameworkVersionOrThrow,
  renderCurrentTemplate,
} from './template.js';
