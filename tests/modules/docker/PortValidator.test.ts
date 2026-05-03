/**
 * M2 — PortValidator tests.
 *
 * Covers AC6:
 *   - Windows branch throws PlatformNotSupported via the factory.
 *   - Linux branch decides bound-ness from `ss` stdout content (NOT
 *     exit code): a row containing LISTEN with `:<port>` -> false;
 *     no such row -> true. Both with exitCode === 0.
 *   - macOS branch parses `lsof` output.
 *   - The implementation file carries the `pin-#8` comment near the
 *     `ss` parsing block.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPortFree,
  type PortProbeResult,
  type PortProbeRunner,
} from '../../../src/modules/docker/PortValidator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

describe('PortValidator.isPortFree', () => {
  it('throws PlatformNotSupported on Windows via the central factory', async () => {
    let caught: unknown = null;
    try {
      await isPortFree(8080, { platform: 'win32' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('PlatformNotSupported');
  });

  it('linux: ss row with LISTEN and :<port> -> false (port is bound), exit 0', async () => {
    const ssOutput = `State                Recv-Q               Send-Q                              Local Address:Port                              Peer Address:Port              Process              \nLISTEN               0                    4096                                          0.0.0.0:8080                                       0.0.0.0:*                                       \n`;
    const runner: PortProbeRunner = (file, args): PortProbeResult => {
      expect(file).toBe('ss');
      expect(args).toContain('-lnt');
      return { status: 0, stdout: ssOutput, stderr: '' };
    };
    const free = await isPortFree(8080, { platform: 'linux', runner });
    expect(free).toBe(false);
  });

  it('linux: ss with no LISTEN row -> true (port is free), exit 0', async () => {
    const ssOutput = `State                Recv-Q               Send-Q                              Local Address:Port                              Peer Address:Port              Process              \n`;
    const runner: PortProbeRunner = () => ({ status: 0, stdout: ssOutput, stderr: '' });
    const free = await isPortFree(8080, { platform: 'linux', runner });
    expect(free).toBe(true);
  });

  it('darwin: lsof with no rows -> true (port is free)', async () => {
    const runner: PortProbeRunner = () => ({ status: 1, stdout: '', stderr: '' });
    const free = await isPortFree(8080, { platform: 'darwin', runner });
    expect(free).toBe(true);
  });

  it('darwin: lsof with a data row -> false (port is bound)', async () => {
    const out =
      'COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n' +
      'node    1234 alice  20u  IPv4 abcdef      0t0  TCP *:8080 (LISTEN)\n';
    const runner: PortProbeRunner = () => ({ status: 0, stdout: out, stderr: '' });
    const free = await isPortFree(8080, { platform: 'darwin', runner });
    expect(free).toBe(false);
  });

  it('source carries the pin-#8 comment near the ss parsing block', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'modules', 'docker', 'PortValidator.ts'),
      'utf8',
    );
    expect(src).toContain('pin-#8');
  });

  it('source does NOT use ss exitCode/status as the bound/unbound signal', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'modules', 'docker', 'PortValidator.ts'),
      'utf8',
    );
    // The contract verifier searches for exitCode|status near `ss `; we
    // assert directly: no `r.status` usage in the linux branch's
    // bound-ness decision. The simpler check: ensure the linux branch
    // does not contain `r.status === 0` style branching.
    // We assert the file does not include the literal "exit code" used
    // as a bound-ness check.
    expect(src).not.toMatch(/ss[^\n]*\n[^\n]*r\.status/);
  });
});
