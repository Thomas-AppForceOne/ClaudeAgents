

import { createHash } from 'node:crypto';

import { stableStringify } from '../config-server/determinism/index.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface TraceMessage {
  role: string;
  content: unknown;
}

export interface TraceToolDefinition {
  name: string;
  description?: string;

  inputSchema?: unknown;
}

export interface LlmRequestIdentity {

  systemPrompt: string;

  userPrompt: string;

  messageHistory: TraceMessage[];

  toolDefinitions: TraceToolDefinition[];

  model: string;
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

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

export function computeInputDigest(inputs: unknown): string {
  return sha256Hex(stableStringify(inputs));
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
