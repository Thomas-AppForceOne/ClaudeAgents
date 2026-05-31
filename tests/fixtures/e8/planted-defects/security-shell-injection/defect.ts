/**
 * Defective `pingHost`: passes a user-controlled host string into
 * `child_process.exec` via string interpolation. The shell evaluates the
 * composed command line, so `host = "127.0.0.1; rm -rf $HOME"` runs both
 * the `ping` and the destructive shell command.
 *
 * Out-of-contract bug: the initial contract only says "ping the supplied
 * host and return the exit code"; the planted defect is the shell-string
 * interpolation, which a reviewer recognises as a classic command-injection
 * vector even without a runnable reproduction.
 */
import { exec } from 'node:child_process';

/**
 * Ping `host` once and resolve to the exit code.
 *
 * @param host hostname or IP. Untrusted; may originate from a form field.
 */
export function pingHost(host: string): Promise<number> {
  return new Promise((resolve) => {
    // BUG: shell-string interpolation. Should use spawn(['ping', '-c', '1', host]).
    exec(`ping -c 1 ${host}`, (err) => {
      resolve(err && typeof err.code === 'number' ? err.code : 0);
    });
  });
}
