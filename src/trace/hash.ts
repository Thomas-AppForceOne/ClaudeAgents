/**
 * Deterministic content hashing for trace refs.
 *
 * Trace events reference payloads (and identify LLM requests) by SHA-256 hex
 * digest rather than by storing bodies inline. The shared guarantee this
 * module provides: identical logical content always hashes to the identical
 * digest. That holds because every hash is taken over a {@link stableStringify}
 * canonical form (key order normalised), so two requests/inputs that differ
 * only in property order collapse to one digest — which is what makes a
 * prompt ref usable as a cache key.
 */

import { createHash } from 'node:crypto';

import { stableStringify } from '../config-server/determinism/index.js';

// Lowercase 64-hex-char SHA-256, used by isSha256Hex to validate refs.
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One message in an LLM request's history. `content` is opaque to hashing. */
export interface TraceMessage {
  role: string;
  content: unknown;
}

/**
 * A tool offered to the model. `description`/`inputSchema` are optional and, in
 * the prompt-ref preimage, normalised to `null` when absent so a present-vs-
 * absent field is distinguishable yet stable.
 */
export interface TraceToolDefinition {
  name: string;
  description?: string;

  inputSchema?: unknown;
}

/**
 * The full identity of an LLM request — everything that, if changed, should
 * change the prompt ref. Hashing all of these together is what lets the ref
 * double as a request-level cache key.
 *
 * @property systemPrompt the system prompt text.
 * @property userPrompt the user prompt text.
 * @property messageHistory prior turns; only `role`/`content` are hashed.
 * @property toolDefinitions available tools; name + description + input schema.
 * @property model the model identifier (different models → different refs).
 */
export interface LlmRequestIdentity {

  systemPrompt: string;

  userPrompt: string;

  messageHistory: TraceMessage[];

  toolDefinitions: TraceToolDefinition[];

  model: string;
}

/**
 * SHA-256 of a string, as lowercase hex. The single hashing primitive the rest
 * of the module builds on. Hashes the UTF-8 encoding of `content`.
 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute the deterministic prompt ref (SHA-256 hex) identifying an LLM
 * request. Same request → same ref, so the ref is safe to use as a cache key.
 *
 * @param identity the request's full identity; every field below feeds the hash.
 * @returns the 64-char lowercase hex digest.
 *
 * The preimage is built deliberately, not by hashing `identity` directly:
 * - a `boundary` tag (`llmRequest/v1`) domain-separates this hash from other
 *   uses of {@link sha256Hex} and lets the preimage format be versioned;
 * - only the fields that define request identity are projected (e.g. messages
 *   contribute role+content, not incidental object identity);
 * - optional tool fields are coerced to `null` so their absence is stable and
 *   cannot collide with a literal value the caller supplied.
 */
export function computePromptRef(identity: LlmRequestIdentity): string {

  const preimage = stableStringify({
    boundary: 'llmRequest/v1',
    model: identity.model,
    systemPrompt: identity.systemPrompt,
    userPrompt: identity.userPrompt,
    messageHistory: identity.messageHistory.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    toolDefinitions: identity.toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
    })),
  });
  return sha256Hex(preimage);
}

/**
 * Compute a deterministic digest of arbitrary agent-attempt inputs. The inputs
 * are canonicalised via {@link stableStringify} before hashing, so two
 * structurally-equal inputs (any property order) produce the same digest —
 * which is what lets a retry with identical inputs be recognised.
 *
 * @param inputs any JSON-shaped value.
 * @returns the 64-char lowercase hex digest.
 */
export function computeInputDigest(inputs: unknown): string {
  return sha256Hex(stableStringify(inputs));
}

/**
 * Type guard: `true` iff `value` is a string matching a lowercase 64-char
 * SHA-256 hex digest. Used to validate refs read back from disk or input.
 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
