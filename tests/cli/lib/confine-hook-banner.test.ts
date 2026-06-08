/**
 * Unit tests for the confinement-hook banner verdict semantics.
 *
 * The two failure modes the verdict surface MUST distinguish:
 *
 *  - `unparseable` — a banner line matched the regex but its semver did
 *                    not parse. This is a hook-side defect the operator
 *                    can correct by editing the banner line.
 *  - `installedUnknown` — the banner DID parse but the framework's own
 *                         `package.json` could not be read, so the
 *                         comparison anchor is missing. This is a
 *                         framework-side defect; the remediation is to
 *                         reinstall the framework, not to edit the hook.
 *
 * A CI gate that fires on `unparseable` would otherwise be unable to tell
 * the two cases apart and would issue the wrong remediation prose.
 */

import { describe, expect, it } from 'vitest';

import { compareBanner } from '../../../src/cli/lib/confine-hook-banner.js';

describe('compareBanner — failure-mode distinction', () => {
  it("banner has bad semver, installedVersion is non-null → 'unparseable'", () => {
    // The banner regex DID match (the parser surfaces the raw version
    // verbatim) but the semver did not parse. The verdict reports the
    // hook-side defect.
    const verdict = compareBanner('not-a-semver', '1.4.0');
    expect(verdict).toBe('unparseable');
  });

  it("installedVersion is null, banner is well-formed semver → 'installedUnknown'", () => {
    // The banner parsed cleanly; only the installed anchor is missing.
    // The verdict reports the framework-side defect.
    const verdict = compareBanner('1.4.0', null);
    expect(verdict).toBe('installedUnknown');
  });

  it("installedVersion has bad semver, banner is well-formed → 'installedUnknown'", () => {
    // A malformed framework-side `package.json` version is still a
    // framework-side defect; it is not the hook's fault and the verdict
    // distinguishes it from `'unparseable'`.
    const verdict = compareBanner('1.4.0', 'not-a-semver');
    expect(verdict).toBe('installedUnknown');
  });

  it("the two failure modes produce observably distinct verdicts", () => {
    // The criterion's load-bearing assertion: the verdicts MUST differ
    // when both call sites surface a comparable failure mode.
    const hookSideDefect = compareBanner('not-a-semver', '1.4.0');
    const frameworkSideDefect = compareBanner('1.4.0', null);
    expect(hookSideDefect).not.toBe(frameworkSideDefect);
  });

  it("absent banner with null installedVersion → 'absent' (precedence)", () => {
    // The `absent` branch precedes the `installedUnknown` check: when
    // the hook carries no banner at all, the installed version is
    // irrelevant. Pinned so a future refactor that re-ordered the
    // branches surfaces here.
    const verdict = compareBanner(null, null);
    expect(verdict).toBe('absent');
  });

  it('the well-formed match case still produces matches/lags/ahead', () => {
    // The new verdict literal is additive; the established three
    // outcomes still fire when both sides parse cleanly.
    expect(compareBanner('1.4.0', '1.4.0')).toBe('matches');
    expect(compareBanner('1.3.0', '1.4.0')).toBe('lags');
    expect(compareBanner('1.5.0', '1.4.0')).toBe('ahead');
  });
});
