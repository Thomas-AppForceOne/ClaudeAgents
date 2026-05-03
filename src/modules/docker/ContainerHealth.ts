/**
 * ContainerHealth — HTTP-level health check that distinguishes "port
 * bound" from "service responding".
 *
 * `waitForHealthy(port, options)` polls
 * `http://localhost:<port><options.path>` via Node's stdlib `fetch`
 * (no `node-fetch` dependency) until the response status equals
 * `options.expectStatus`, or until `options.timeoutSeconds` elapses.
 *
 * Per-poll bound: each `fetch` is wrapped in an `AbortController` whose
 * timeout is `Math.min(2000, remainingBudgetMs)` so a single hung poll
 * can never consume the entire budget. The polling loop sleeps
 * 200ms between attempts (when not at the budget edge).
 *
 * On timeout the helper throws `TimeoutError` via the central error
 * factory; the thrown error includes a `lastResponse` field (when a
 * fetch returned a status code) and/or a `lastError` field (when a
 * fetch threw).
 */

import { createError } from '../../config-server/errors.js';

export interface WaitForHealthyOptions {
  path: string;
  expectStatus: number;
  timeoutSeconds: number;
  /**
   * Test injection: override the `fetch` implementation. Defaults to
   * the global `fetch`. The signature mirrors `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Test injection: override the `host` part of the URL. Defaults to `localhost`. */
  host?: string;
}

/**
 * Poll the target until `expectStatus` is observed; return `true`. On
 * timeout, throw `TimeoutError` whose details include the last
 * status-code observation (`lastResponse`) and/or the last fetch error
 * (`lastError`).
 */
export async function waitForHealthy(
  port: number,
  options: WaitForHealthyOptions,
): Promise<true> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  const host = options.host ?? 'localhost';
  const url = `http://${host}:${port}${options.path}`;
  const totalBudgetMs = Math.max(0, Math.floor(options.timeoutSeconds * 1000));
  const start = Date.now();

  let lastResponse: { status: number } | undefined;
  let lastError: string | undefined;
  let attempts = 0;

  while (true) {
    attempts += 1;
    const elapsed = Date.now() - start;
    const remaining = totalBudgetMs - elapsed;
    if (remaining <= 0) break;

    const perPollMs = Math.min(2000, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perPollMs);

    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      lastResponse = { status: res.status };
      // Drain the body so the connection can close cleanly. We do not
      // care about the content — the status code is the signal.
      try {
        await res.text();
      } catch {
        // Ignore body-read failures; the status was already captured.
      }
      if (res.status === options.expectStatus) {
        clearTimeout(timer);
        return true;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }

    // Sleep 200ms between polls, but never past the remaining budget.
    const slept = Math.min(200, Math.max(0, totalBudgetMs - (Date.now() - start)));
    if (slept > 0) {
      await new Promise<void>((r) => setTimeout(r, slept));
    } else {
      break;
    }
  }

  throw createError('TimeoutError', {
    message:
      `ContainerHealth.waitForHealthy timed out after ${options.timeoutSeconds}s ` +
      `polling '${url}' (attempts=${attempts}). ` +
      (lastResponse ? `lastResponse.status=${lastResponse.status}. ` : '') +
      (lastError ? `lastError=${lastError}.` : ''),
    url,
    attempts,
    ...(lastResponse ? { lastResponse } : {}),
    ...(lastError ? { lastError } : {}),
  });
}
