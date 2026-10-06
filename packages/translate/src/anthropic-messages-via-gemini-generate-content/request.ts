import { klona } from 'klona/json';

import { filterAnthropicMessagesClientTools } from '../shared/anthropic-messages-via/client-tools.ts';
import { flattenAnthropicMessagesToolResult } from '../shared/anthropic-messages-via/tool-result.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesClientTool,
  AnthropicMessagesImageBlock,
  AnthropicMessagesMessage,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlock,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import type {
  GeminiGenerateContentContent,
  GeminiGenerateContentFunctionDeclaration,
  GeminiGenerateContentPart,
  GeminiGenerateContentPayload,
  GeminiGenerateContentToolGroup,
} from '@floway-dev/protocols/gemini-generate-content';

const textPart = (block: AnthropicMessagesTextBlock): GeminiGenerateContentPart => ({ text: block.text });

const inlineDataPart = (block: AnthropicMessagesImageBlock): GeminiGenerateContentPart => ({
  inlineData: { mimeType: block.source.media_type, data: block.source.data },
});

// Tool-result parts name the call they answer; Anthropic Messages carries only
// the tool_use id. The request builder records every tool_use id → name pair
// while walking the history so the response part can restore the name. An
// unmatched id stays verbatim — upstream validation rejects the turn either
// way, and forwarding the caller's own value keeps the failure diagnosable.
export interface GeminiGenerateContentToolNamesById {
  [id: string]: string;
}

const translateToolResultBlock = (block: AnthropicMessagesToolResultBlock, toolNamesById: GeminiGenerateContentToolNamesById): GeminiGenerateContentPart => {
  const response: Record<string, unknown> = typeof block.content === 'string'
    ? { result: block.content }
    : { result: flattenAnthropicMessagesToolResult(block.content) };
  return {
    functionResponse: { id: block.tool_use_id, name: toolNamesById[block.tool_use_id] ?? block.tool_use_id, response },
  };
};

const partFromUserBlock = (block: AnthropicMessagesUserContentBlock, toolNamesById: GeminiGenerateContentToolNamesById): GeminiGenerateContentPart | null => {
  switch (block.type) {
  case 'text':
    return textPart(block);
  case 'image':
    return inlineDataPart(block);
  case 'tool_result':
    return translateToolResultBlock(block, toolNamesById);
  }
};

const translateUserMessage = (
  content: Exclude<AnthropicMessagesMessage, { role: 'assistant' | 'system' }>['content'],
  toolNamesById: GeminiGenerateContentToolNamesById,
): GeminiGenerateContentContent => {
  if (typeof content === 'string') return { role: 'user', parts: [{ text: content }] };
  return {
    role: 'user',
    parts: content.map(block => partFromUserBlock(block, toolNamesById)).filter((part): part is GeminiGenerateContentPart => part !== null),
  };
};

const translateAssistantMessage = (
  message: AnthropicMessagesMessage & { role: 'assistant' },
  toolNamesById: GeminiGenerateContentToolNamesById,
): GeminiGenerateContentContent => {
  if (typeof message.content === 'string') {
    return { role: 'model', parts: [{ text: message.content }] };
  }

  const parts: GeminiGenerateContentPart[] = [];
  // Gemini generateContent attaches a thoughtSignature to the part that follows
  // the reasoning it signs, and a replayed thinking block (or its redacted
  // carrier) is where the signature returns. The first visible part after the
  // reasoning carries it.
  let pendingSignature: string | undefined;
  const signed = (part: GeminiGenerateContentPart): GeminiGenerateContentPart => (pendingSignature === undefined ? part : { ...part, thoughtSignature: pendingSignature });

  for (const block of message.content as AnthropicMessagesAssistantContentBlock[]) {
    switch (block.type) {
    case 'thinking':
      if (block.signature !== undefined) pendingSignature = block.signature;
      parts.push({ text: block.thinking, thought: true });
      break;
    case 'redacted_thinking':
      pendingSignature ??= block.data;
      break;
    case 'text':
      parts.push(signed({ text: block.text }));
      break;
    case 'tool_use':
      toolNamesById[block.id] = block.name;
      parts.push(signed({ functionCall: { id: block.id, name: block.name, args: klona(block.input) } }));
      break;
    case 'server_tool_use':
    case 'web_search_tool_result':
      // Server-side search state has no Gemini generateContent replay slot; the
      // upstream re-grounds on its own tools if the request carries them.
      break;
    case 'fallback':
      throw new TranslatorInputError('"fallback" blocks are not supported in Gemini generateContent assistant content.');
    default:
      throw new TranslatorInputError(`"${(block as { type: string }).type}" blocks are not supported in Gemini generateContent assistant content.`);
    }
  }

  if (parts.length === 0) {
    // A signature arrived with no visible part to attach to — keep it as a
    // carrier part so a signed history replay is not silently lost.
    if (pendingSignature === undefined) return { role: 'model', parts: [] };
    return { role: 'model', parts: [{ text: '', thoughtSignature: pendingSignature }] };
  }

  return { role: 'model', parts };
};

const translateSystemContent = (content: NonNullable<AnthropicMessagesPayload['system']>): GeminiGenerateContentContent | undefined => {
  if (typeof content === 'string') {
    return content.length > 0 ? { parts: [{ text: content }] } : undefined;
  }
  const parts = content.map(textPart);
  return parts.length ? { parts } : undefined;
};

const declarationFromClientTool = (tool: AnthropicMessagesClientTool): GeminiGenerateContentFunctionDeclaration => ({
  name: tool.name,
  ...(tool.description !== undefined ? { description: tool.description } : {}),
  parameters: klona(tool.input_schema),
});

const buildTools = (payload: AnthropicMessagesPayload): GeminiGenerateContentToolGroup[] | undefined => {
  const declarations = (filterAnthropicMessagesClientTools(payload.tools) ?? []).map(declarationFromClientTool);
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
};

const applyToolChoice = (request: GeminiGenerateContentPayload, toolChoice: NonNullable<AnthropicMessagesPayload['tool_choice']>): void => {
  switch (toolChoice.type) {
  case 'none':
    request.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    return;
  case 'auto':
    request.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    return;
  case 'any':
    request.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    return;
  case 'tool':
    request.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name ?? ''] } };
    return;
  }
};

export const buildTargetRequest = (payload: AnthropicMessagesPayload): GeminiGenerateContentPayload => {
  const request: GeminiGenerateContentPayload = { contents: [] };
  const toolNamesById: GeminiGenerateContentToolNamesById = {};
  let lastSystem: GeminiGenerateContentContent | undefined;

  if (payload.system !== undefined) {
    lastSystem = translateSystemContent(payload.system);
    if (lastSystem) request.systemInstruction = lastSystem;
  }

  for (const message of payload.messages) {
    if (message.role === 'system') {
      // An inline system message repeats the instruction slot; later
      // occurrences win, matching how the other `*-via-*` translators collapse
      // repeated system turns.
      lastSystem = translateSystemContent(message.content);
      if (lastSystem) request.systemInstruction = lastSystem;
      continue;
    }
    if (message.role === 'assistant') {
      const turn = translateAssistantMessage(message, toolNamesById);
      if (turn.parts.length > 0) request.contents!.push(turn);
      continue;
    }
    const turn = translateUserMessage(message.content, toolNamesById);
    if (turn.parts.length > 0) request.contents!.push(turn);
  }

  const generationConfig: NonNullable<GeminiGenerateContentPayload['generationConfig']> = {
    // AnthropicMessagesPayload requires max_tokens, so the target always
    // carries an explicit output cap.
    maxOutputTokens: payload.max_tokens,
  };
  if (payload.temperature !== undefined) generationConfig.temperature = payload.temperature;
  if (payload.top_p !== undefined) generationConfig.topP = payload.top_p;
  if (payload.top_k !== undefined) generationConfig.topK = payload.top_k;
  if (payload.stop_sequences !== undefined) generationConfig.stopSequences = klona(payload.stop_sequences);
  if (payload.thinking !== undefined) {
    switch (payload.thinking.type) {
    case 'enabled':
      if (payload.thinking.budget_tokens !== undefined) generationConfig.thinkingConfig = { thinkingBudget: payload.thinking.budget_tokens };
      break;
    case 'adaptive':
      // Gemini generateContent has no adaptive slot; a positive budget reads as
      // "as much as fits" to the same effect. Omitted leaves the model default.
      // https://ai.google.dev/gemini-api/docs/thinking
      generationConfig.thinkingConfig = { includeThoughts: true };
      break;
    case 'disabled':
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
      break;
    }
  }
  request.generationConfig = generationConfig;

  const tools = buildTools(payload);
  if (tools) {
    request.tools = tools;
    if (payload.tool_choice !== undefined) applyToolChoice(request, payload.tool_choice);
  }

  return request;
};
