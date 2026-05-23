/**
 * promptRef hash-boundary suite — defines exactly which request fields are
 * inside the identity hash and which are deliberately excluded, so the hash is
 * a stable cache/dedup key for "the same prompt" across runs.
 *
 * Determinism: equal content hashes to a byte-identical ref, and the ref is a
 * bare lowercase 64-hex string with NO `sha256:` prefix (the storage layer
 * assumes that exact shape). Message history is order-SENSITIVE — reversing two
 * turns changes the ref — because turn order is part of prompt identity.
 *
 * Boundary correctness — the load-bearing distinction:
 * - IN-boundary (must change the ref): model, systemPrompt, userPrompt,
 *   messageHistory, toolDefinitions. Each is varied alone and must differ.
 * - OUT-of-boundary (must NOT change the ref): sampling/runtime knobs and
 *   trace metadata — temperature, topP, topK, seed, maxTokens, runId,
 *   timestamp. Each is varied alone, and then ALL at once, and the ref must
 *   stay equal to the base. This keeps the hash keyed to *what was asked*, not
 *   *how it was sampled or when it ran*, so two runs with the same prompt but
 *   different seeds/timestamps still collide intentionally.
 */

import { describe, expect, it } from 'vitest';

import { computePromptRef, isSha256Hex, type LlmRequestIdentity } from '../../src/trace/hash.js';

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
