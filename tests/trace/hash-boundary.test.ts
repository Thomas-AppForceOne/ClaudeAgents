/**
 * T1 Sprint 2 — hash boundary (F2.3).
 *
 * Covers contract criteria:
 *  - hash_boundary_determinism: equal in-boundary content ⇒ byte-identical
 *    bare-64-hex promptRef.
 *  - hash_boundary_correctness: varying any OUT-of-boundary field (temperature,
 *    top-p, top-k, seed, max-tokens, run-id, timestamp) leaves promptRef
 *    unchanged.
 */
import { describe, expect, it } from 'vitest';

import { computePromptRef, isSha256Hex, type LlmRequestIdentity } from '../../src/trace/hash.js';

/** A representative in-boundary request identity used across the suite. */
function baseIdentity(): LlmRequestIdentity {
  return {
    model: 'claude-opus-4',
    systemPrompt: 'You are a careful engineer.',
    userPrompt: 'Implement the trace library.',
    messageHistory: [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first reply' },
    ],
    toolDefinitions: [
      { name: 'Read', description: 'Read a file', inputSchema: { type: 'object' } },
      { name: 'Write', description: 'Write a file', inputSchema: { type: 'object' } },
    ],
  };
}

describe('hash boundary — determinism (hash_boundary_determinism)', () => {
  it('produces byte-identical promptRef for two requests built from equal content', () => {
    const a = computePromptRef(baseIdentity());
    const b = computePromptRef(baseIdentity());
    expect(a).toBe(b);
  });

  it('emits a bare lowercase 64-hex string with no sha256: prefix', () => {
    const ref = computePromptRef(baseIdentity());
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.startsWith('sha256:')).toBe(false);
    expect(isSha256Hex(ref)).toBe(true);
  });

  it('changes the promptRef when an IN-boundary field changes', () => {
    const base = computePromptRef(baseIdentity());
    const diffModel = computePromptRef({ ...baseIdentity(), model: 'claude-sonnet-4' });
    const diffSystem = computePromptRef({
      ...baseIdentity(),
      systemPrompt: 'You are a sloppy engineer.',
    });
    const diffUser = computePromptRef({ ...baseIdentity(), userPrompt: 'Do something else.' });
    const diffHistory = computePromptRef({
      ...baseIdentity(),
      messageHistory: [{ role: 'user', content: 'totally different' }],
    });
    const diffTools = computePromptRef({
      ...baseIdentity(),
      toolDefinitions: [{ name: 'Bash' }],
    });
    expect(diffModel).not.toBe(base);
    expect(diffSystem).not.toBe(base);
    expect(diffUser).not.toBe(base);
    expect(diffHistory).not.toBe(base);
    expect(diffTools).not.toBe(base);
  });

  it('is sensitive to message-history ORDER (order-deterministic, not order-agnostic)', () => {
    const forward = computePromptRef(baseIdentity());
    const reversed = computePromptRef({
      ...baseIdentity(),
      messageHistory: [
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'first turn' },
      ],
    });
    expect(reversed).not.toBe(forward);
  });
});

describe('hash boundary — correctness (hash_boundary_correctness)', () => {
  const base = computePromptRef(baseIdentity());

  // Out-of-boundary fields are modelled by augmenting the request object with
  // extra knobs the boundary type does not include; `computePromptRef` only
  // reads the in-boundary fields, so these must never change the hash.
  const outOfBoundaryCases: Array<[string, Record<string, unknown>]> = [
    ['temperature', { temperature: 0.9 }],
    ['top-p', { topP: 0.1 }],
    ['top-k', { topK: 40 }],
    ['seed', { seed: 1234567 }],
    ['max-tokens', { maxTokens: 8192 }],
    ['run-id', { runId: 'some-other-run' }],
    ['timestamp', { timestamp: '2026-05-21T19:47:20.123Z' }],
  ];

  for (const [label, extra] of outOfBoundaryCases) {
    it(`leaves promptRef unchanged when only ${label} varies`, () => {
      const withExtra = computePromptRef({ ...baseIdentity(), ...extra } as LlmRequestIdentity);
      expect(withExtra).toBe(base);
    });
  }

  it('leaves promptRef unchanged when ALL out-of-boundary fields vary at once', () => {
    const all = computePromptRef({
      ...baseIdentity(),
      temperature: 0.3,
      topP: 0.95,
      topK: 10,
      seed: 42,
      maxTokens: 1024,
      runId: 'yet-another-run',
      timestamp: '1999-01-01T00:00:00.000Z',
    } as LlmRequestIdentity);
    expect(all).toBe(base);
  });
});
