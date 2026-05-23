// Contract for PortValidator.isPortFree — the cross-platform "is this host port
// already bound?" probe. Windows is explicitly unsupported and must throw
// PlatformNotSupported via the central error factory. On Linux it shells out to
// `ss -lnt` and on macOS to `lsof`; the verdict comes from PARSING the output for a
// LISTEN/binding row, NOT from the process exit code. That distinction is the whole
// point of two source-shape guards at the bottom: the implementation must carry the
// "pin-#8" rationale comment near the ss-parsing block, and must not use ss's exit
// status as the bound/unbound signal (ss exits 0 whether or not the port is bound,
// so trusting status would misreport every port as the same state).
//
// All probes are injected via a PortProbeRunner stub, so no real port is ever
// opened and the platform is chosen by the `platform` option rather than the host.

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
    // ss output with a header row plus one LISTEN row binding 0.0.0.0:8080.
    // Status is 0 here on purpose: the verdict must come from the LISTEN row, not exit code.
    const ssOutput = `State                Recv-Q               Send-Q                              Local Address:Port                              Peer Address:Port              Process              \nLISTEN               0                    4096                                          0.0.0.0:8080                                       0.0.0.0:*                                       \n`;
    const runner: PortProbeRunner = (file, args): PortProbeResult => {
      // Also pins the invocation: Linux must probe via `ss -lnt`.
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
    // lsof returns exit status 1 (no matches) AND empty stdout when nothing holds
    // the port; empty output is what marks it free.
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

  // Source-shape guard: the rationale for parsing-over-exit-code must stay anchored
  // in the source as a "pin-#8" marker, so a future edit cannot quietly drop it.
  it('source carries the pin-#8 comment near the ss parsing block', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'modules', 'docker', 'PortValidator.ts'),
      'utf8',
    );
    expect(src).toContain('pin-#8');
  });

  // Regression guard: ensure no line referencing ss is immediately followed by a
  // line reading r.status — i.e. the exit code is never used as the bound signal.
  it('source does NOT use ss exitCode/status as the bound/unbound signal', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'modules', 'docker', 'PortValidator.ts'),
      'utf8',
    );

    expect(src).not.toMatch(/ss[^\n]*\n[^\n]*r\.status/);
  });
});
