

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { waitForHealthy } from '../../../src/modules/docker/ContainerHealth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function makeResponse(status: number): Response {
  return new Response('', { status });
}

describe('ContainerHealth.waitForHealthy', () => {
  it('happy path: returns true when fetch returns expectStatus', async () => {
    const fetchImpl: typeof fetch = async () => makeResponse(200);
    const result = await waitForHealthy(8080, {
      path: '/health',
      expectStatus: 200,
      timeoutSeconds: 2,
      fetchImpl,
    });
    expect(result).toBe(true);
  });

  it('timeout path: TimeoutError with non-empty diagnostic when status never matches', async () => {
    const fetchImpl: typeof fetch = async () => makeResponse(503);
    let caught: unknown = null;
    try {
      await waitForHealthy(8080, {
        path: '/health',
        expectStatus: 200,
        timeoutSeconds: 1,
        fetchImpl,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('TimeoutError');
    const msg = (caught as Error).message;
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain('lastResponse.status=503');
  });

  it('per-poll abort: at least 2 poll attempts within a 5s budget against a slow server', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      attempts += 1;

      return new Promise<Response>((resolve, reject) => {
        const sig = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        if (sig) {
          sig.addEventListener('abort', () =>
            reject(new Error('aborted by test (per-poll timeout)')),
          );
        }
        // Never resolve on its own.
      });
    };
    let caught: unknown = null;
    try {
      await waitForHealthy(8080, {
        path: '/health',
        expectStatus: 200,
        timeoutSeconds: 5,
        fetchImpl,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('TimeoutError');

    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 10000);

  it('source uses AbortController and stdlib fetch (no node-fetch dependency)', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'modules', 'docker', 'ContainerHealth.ts'),
      'utf8',
    );
    const matchAbort = src.match(/AbortController|fetch\(/g) ?? [];
    expect(matchAbort.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/from ['"]node-fetch['"]|require\(['"]node-fetch['"]\)/);
  });
});
