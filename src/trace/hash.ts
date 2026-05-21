/**
 * T1 Sprint 2 — the load-bearing hash boundary (F2.3) and content hashing.
 *
 * `promptRef` / `inputDigest` (and the content hashes that back payload refs
 * in hashed mode) are SHA-256, hex-encoded lowercase, exactly 64 chars, with
 * NO `sha256:` prefix — bare 64-hex per T1's "Field encodings". This is
 * deliberately different from `src/config-server/trust/hash.ts`, which
 * prepends `sha256:` for the trust cache. We follow the same `node:crypto`
 * `createHash('sha256').digest('hex')` pattern but emit the bare form.
 *
 * The hash boundary identifies "the same logical request to the model" so
 * cache-hit and cross-run comparison are honest (T2/V1). The boundary is:
 *
 *   IN  the hash: system prompt, user prompt, full message history, tool
 *       definitions, model name.
 *   OUT of the hash: temperature, top-p, top-k, seed, max-tokens, run-id,
 *       timestamps, and any per-run-varying field.
 *
 * Determinism is achieved by hashing a CANONICAL serialisation of exactly the
 * in-boundary fields, in a fixed order, via the repo's `stableStringify`
 * (sorted keys at every depth). Out-of-boundary fields never enter the
 * pre-image, so varying them cannot change the hash.
 */

import { createHash } from 'node:crypto';

import { stableStringify } from '../config-server/determinism/index.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One message in the request's message history. */
export interface TraceMessage {
  role: string;
  content: unknown;
}

/** One tool definition exposed to the model for the request. */
export interface TraceToolDefinition {
  name: string;
  description?: string;
  /** The tool's input schema (JSON Schema or equivalent). */
  inputSchema?: unknown;
}

/**
 * The logical identity of an LLM request. Exactly the IN-boundary fields.
 * Out-of-boundary knobs (temperature, top-p, top-k, seed, max-tokens) and
 * per-run-varying fields (run-id, timestamps) are intentionally absent from
 * this type so they cannot be folded into the pre-image by accident.
 */
export interface LlmRequestIdentity {
  /** The system prompt. */
  systemPrompt: string;
  /** The user prompt. */
  userPrompt: string;
  /** The full message history, in order. */
  messageHistory: TraceMessage[];
  /** The tool definitions exposed to the model. */
  toolDefinitions: TraceToolDefinition[];
  /** The model name. */
  model: string;
}

/**
 * Compute the bare lowercase 64-hex SHA-256 of an arbitrary string. The single
 * primitive every other hash in this module folds through.
 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute the `promptRef` for an LLM request: the bare 64-hex SHA-256 over a
 * canonical serialisation of EXACTLY the in-boundary fields, in a fixed
 * order. Order-deterministic: two requests built from equal in-boundary
 * content produce byte-identical hashes; varying any out-of-boundary field
 * leaves the hash unchanged because it never enters the pre-image.
 */
export function computePromptRef(identity: LlmRequestIdentity): string {
  // Fixed key order is enforced by stableStringify (sorted at every depth),
  // so the literal order of the object below does not matter — but we still
  // pin only the in-boundary fields. Message history order is preserved
  // because arrays are not reordered by stableStringify.
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
 * Compute the `inputDigest` for an agent attempt: the bare 64-hex SHA-256 of
 * the canonical serialisation of the inputs fed to the agent. Same encoding
 * as `promptRef`; the caller supplies whatever input bundle defines the
 * attempt's logical identity.
 */
export function computeInputDigest(inputs: unknown): string {
  return sha256Hex(stableStringify(inputs));
}

/** True iff `value` is a bare lowercase 64-char hex SHA-256 (no prefix). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
