import { describe, expect, test } from 'vitest';

import {
  buildAntigravityEnvelope,
  createAntigravityUnwrapState,
  syntheticTerminalIfMissing,
  unwrapAntigravitySseChunk,
} from '../src/envelope.ts';
import type {
  GeminiGenerateContentPayload,
  GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';

const payload = {
  model: 'gemini-3-pro',
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
  generationConfig: { temperature: 0.5 },
} as GeminiGenerateContentPayload & { model: string };

describe('buildAntigravityEnvelope', () => {
  test('wraps the stripped request at the same request id across retries', async () => {
    const envelope = await buildAntigravityEnvelope({ projectId: 'proj-1', model: 'gemini-3-pro', payload });
    expect(envelope.project).toBe('proj-1');
    expect(envelope.model).toBe('gemini-3-pro');
    expect(envelope.userAgent).toBe('antigravity');
    expect(envelope.requestType).toBe('agent');
    expect(envelope.requestId).toMatch(/^agent-/);
    // `model` rides the URL and the envelope, not the inner request.
    expect(envelope.request).not.toHaveProperty('model');
    expect(envelope.request).not.toHaveProperty('safetySettings');
    expect((envelope.request as { generationConfig?: unknown }).generationConfig).toEqual({ temperature: 0.5 });
    // sessionId is derived from the first user turn's text.
    expect((envelope.request as { sessionId?: string }).sessionId).toMatch(/^-/);
    // Same payload → same session slot; a different payload → a different one.
    const again = await buildAntigravityEnvelope({ projectId: 'proj-1', model: 'gemini-3-pro', payload });
    expect((again.request as { sessionId: string }).sessionId)
      .toBe((envelope.request as { sessionId: string }).sessionId);
    const other = await buildAntigravityEnvelope({
      projectId: 'proj-1',
      model: 'gemini-3-pro',
      payload: { ...payload, contents: [{ role: 'user', parts: [{ text: 'different' }] }] },
    });
    expect((other.request as { sessionId: string }).sessionId)
      .not.toBe((envelope.request as { sessionId: string }).sessionId);
  });
});

describe('unwrapAntigravitySseChunk', () => {
  const state = () => createAntigravityUnwrapState();

  test('unwraps the response envelope and drops non-terminal usageMetadata', () => {
    const state1 = state();
    const staged: GeminiGenerateContentStreamEvent = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    };
    expect(unwrapAntigravitySseChunk({ response: staged }, state1)).toEqual([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, index: 0 }] },
    ]);
    // The figures still land in state for the synthetic terminal to carry.
    expect(state1.lastUsageMetadata).toEqual({ promptTokenCount: 5, candidatesTokenCount: 2 });
    expect(state1.sawTerminal).toBe(false);
  });

  test('keeps terminal chunks intact, usageMetadata included', () => {
    const state1 = state();
    const terminal: GeminiGenerateContentStreamEvent = {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
    };
    expect(unwrapAntigravitySseChunk({ response: terminal }, state1)).toEqual([terminal]);
    expect(state1.sawTerminal).toBe(true);
  });

  test('passes a wrapped error straight through', () => {
    expect(unwrapAntigravitySseChunk({ response: { error: { code: 429, message: 'quota' } } }, state())).toEqual([
      { error: { code: 429, message: 'quota' } },
    ]);
  });

  test('drops frames without a response envelope', () => {
    expect(unwrapAntigravitySseChunk({ other: true }, state())).toEqual([]);
    expect(unwrapAntigravitySseChunk({ response: 'not-an-object' }, state())).toEqual([]);
  });
});

describe('syntheticTerminalIfMissing', () => {
  test('synthesizes a STOP carrying the staged usage at [DONE]', () => {
    const state1 = createAntigravityUnwrapState();
    const staged: GeminiGenerateContentStreamEvent = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    };
    unwrapAntigravitySseChunk({ response: staged }, state1);
    const synthesized = syntheticTerminalIfMissing(state1, 'gemini-3-pro');
    expect(synthesized).toHaveLength(1);
    const [chunk] = synthesized as { candidates?: { finishReason?: string }[]; usageMetadata?: unknown; modelVersion?: string }[];
    expect(chunk.candidates?.[0]?.finishReason).toBe('STOP');
    expect(chunk.usageMetadata).toEqual({ promptTokenCount: 5, candidatesTokenCount: 2 });
    expect(chunk.modelVersion).toBe('gemini-3-pro');
  });

  test('emits nothing when the stream did terminate', () => {
    const state1 = createAntigravityUnwrapState();
    const terminal: GeminiGenerateContentStreamEvent = {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
    };
    unwrapAntigravitySseChunk({ response: terminal }, state1);
    expect(syntheticTerminalIfMissing(state1, 'gemini-3-pro')).toEqual([]);
  });

  test('synthesizes once — idempotent across repeated calls', () => {
    const state1 = createAntigravityUnwrapState();
    expect(syntheticTerminalIfMissing(state1, 'm')).toHaveLength(1);
    expect(syntheticTerminalIfMissing(state1, 'm')).toEqual([]);
  });

  test('without staged usage the synthesized STOP carries none', () => {
    const state1 = createAntigravityUnwrapState();
    const [chunk] = syntheticTerminalIfMissing(state1, 'gemini-3-pro') as { usageMetadata?: unknown }[];
    expect(chunk).not.toHaveProperty('usageMetadata');
  });
});
