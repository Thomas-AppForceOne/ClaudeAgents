/**
 * PortValidator — platform-aware "is this port free?" check.
 *
 * Returns synchronously (`Promise<boolean>` for forward compatibility,
 * but the underlying implementation is synchronous; callers should
 * `await` the return for symmetry with future async branches).
 *
 * Platform branches:
 *  - **darwin** (`process.platform === 'darwin'`): runs `lsof -i :<port>`
 *    via `spawnSync`. If lsof prints any rows, the port is bound; if
 *    it prints nothing, the port is free.
 *  - **linux**: runs `ss -lnt sport = :<port>`. **Bound-ness is decided
 *    by parsing `ss`'s stdout, NOT by its exit code** — `ss` returns
 *    exit 0 in both bound and unbound cases. The parser looks for a
 *    `LISTEN` row whose local-address field ends with `:<port>`.
 *  - **win32**: throws `PlatformNotSupported` via the central error
 *    factory. The docker module is macOS + Linux only in v1.
 *
 * Tests inject the platform via `process.platform` overrides and stub
 * the `spawnSync`-style runner so the parsing code can be exercised
 * without touching real binaries.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { createError } from '../../config-server/errors.js';

/** Result type matching `spawnSync`'s return shape (subset we use). */
export interface PortProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runner stub for tests. Mirrors `spawnSync` minus signal/stdio knobs. */
export type PortProbeRunner = (file: string, args: readonly string[]) => PortProbeResult;

const defaultRunner: PortProbeRunner = (file, args) => {
  const r: SpawnSyncReturns<Buffer> = spawnSync(file, [...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r.status,
    stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
  };
};

/** Optional knobs (test injection points). */
export interface IsPortFreeOptions {
  /** Override `process.platform`. Tests pass `'win32'` etc. */
  platform?: NodeJS.Platform;
  /** Override the `spawnSync`-style runner. Tests inject a parser fixture. */
  runner?: PortProbeRunner;
}

/**
 * Returns `true` when `port` is free, `false` when it is bound to a
 * listener. macOS uses `lsof`; Linux uses `ss`; Windows throws
 * `PlatformNotSupported`.
 */
export function isPortFree(port: number, options: IsPortFreeOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;

  if (platform === 'win32') {
    throw createError('PlatformNotSupported', {
      message:
        'PortValidator.isPortFree is not supported on Windows. The docker module is macOS + Linux only in v1.',
    });
  }

  if (platform === 'darwin') {
    const r = runner('lsof', ['-i', `:${port}`, '-P', '-n']);
    // lsof exits non-zero when nothing is bound. Parse stdout for any
    // non-empty content past the header.
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Drop the header row if present.
    const dataRows = lines.filter((l) => !/^COMMAND\s+PID/.test(l));
    return Promise.resolve(dataRows.length === 0);
  }

  if (platform === 'linux') {
    const r = runner('ss', ['-lnt', 'sport', '=', `:${port}`]);
    // pin-#8: `ss` returns exit 0 in both bound and unbound cases on
    // Linux, so we MUST decide bound-ness from stdout content. Look for
    // a row containing the LISTEN state whose local-address column ends
    // with `:<port>`.
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      // Skip header.
      if (/^State\s+/i.test(line)) continue;
      if (!/\bLISTEN\b/.test(line)) continue;
      // Local-Address:Port column matching: any token ending with :<port>.
      const tokens = line.split(/\s+/);
      for (const tok of tokens) {
        if (tok.endsWith(`:${port}`)) {
          return Promise.resolve(false);
        }
      }
    }
    return Promise.resolve(true);
  }

  throw createError('PlatformNotSupported', {
    message: `PortValidator.isPortFree is not supported on platform '${platform}'.`,
  });
}
