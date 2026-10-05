import { klona } from 'klona/json';

import { TranslatorInputError } from '../translator-input-error.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentFunctionDeclaration, GeminiGenerateContentPart, GeminiGenerateContentPayload, GeminiGenerateContentToolGroup } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsContentPart, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';

// Tool-result parts name the call they answer; Chat Completions carries only
// the tool_call_id. The request builder records every assistant tool_call
// id → name pair while walking the history so the response part can restore
// the name — the same registry the anthropic-messages-via pair keeps for
// tool_use ids, scoped per trip through the closure.
interface ToolCallNamesById {
  [id: string]: string;
}

const textPart = (text: string): GeminiGenerateContentPart => ({ text });

const inlineDataPart = (part: Extract<OpenAIChatCompletionsContentPart, { type: 'image_url' }>): GeminiGenerateContentPart | null => {
  // Chat Completions image parts point at a URL that may be a remote https
  // resource, which Gemini generateContent carries as fileData — or a base64
  // data: URL, which it carries as inlineData. A URL that is neither is
  // dropped; the image_url detail hint has no Gemini slot.
  // https://ai.google.dev/api/caching#Filedata
  const url = part.image_url.url;
  const dataUrl = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(url);
  if (dataUrl) return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const mimeType = /\.(jpe?g|png|gif|webp)(\?|$)/i.exec(url)?.[1];
    return { fileData: { mimeType: mimeType ? `image/${mimeType === 'jpg' ? 'jpeg' : mimeType}` : 'image/jpeg', fileUri: url } };
  }
  return null;
};

const functionCallPart = (toolCall: { id: string; function: { name: string; arguments: string } }, toolNamesById: ToolCallNamesById): GeminiGenerateContentPart => {
  let args: Record<string, unknown> = {};
  if (toolCall.function.arguments) {
    try {
      args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch (error) {
      throw new TranslatorInputError(`tool_calls function arguments for '${toolCall.id}' were not valid JSON.`, { param: 'tools' });
    }
  }
  toolNamesById[toolCall.id] = toolCall.function.name;
  return { functionCall: { id: toolCall.id, name: toolCall.function.name, args } };
};

const translateAssistantMessage = (message: OpenAIChatCompletionsMessage, toolNamesById: ToolCallNamesById): GeminiGenerateContentContent => {
  const parts: GeminiGenerateContentPart[] = [];

  // Human-readable reasoning rides the thought slot the response direction
  // emits; the opaque signature re-attaches later on whatever part leads the
  // visible content, mirroring the assistant-side signature placement used
  // by the other reverse pairs.
  const reasoningText = message.reasoning_text ?? message.reasoning_content ?? message.reasoning;
  if (typeof reasoningText === 'string' && reasoningText) parts.push({ text: reasoningText, thought: true });

  if (typeof message.content === 'string') {
    if (message.content) parts.push(textPart(message.content));
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) parts.push(textPart(part.text));
      } else if (part.type === 'refusal') {
        // Chat Completions carries refusal as its own part; Gemini
        // generateContent has no refusal slot, so the text rides as plain.
        if (part.refusal) parts.push(textPart(part.refusal));
      } else {
        const media = inlineDataPart(part);
        if (media) parts.push(media);
      }
    }
  }

  if (typeof message.refusal === 'string' && message.refusal && parts.every(part => part.thought === true)) {
    parts.push(textPart(message.refusal));
  }

  for (const toolCall of message.tool_calls ?? []) {
    parts.push(functionCallPart(toolCall, toolNamesById));
  }

  return { role: 'model', parts };
};

const translateToolMessage = (message: OpenAIChatCompletionsMessage, toolNamesById: ToolCallNamesById): GeminiGenerateContentContent => {
  if (typeof message.tool_call_id !== 'string' || message.tool_call_id === '') {
    throw new TranslatorInputError("Missing required field 'tool_call_id' on a 'tool' role message.");
  }

  let response: unknown;
  if (typeof message.content === 'string') {
    // Chat Completions tool output is a string; Gemini expects the response
    // field to carry an object, so structured output round-trips as an
    // object and unstructured text stays a bare string value.
    try {
      response = JSON.parse(message.content) as unknown;
    } catch {
      response = message.content;
    }
  } else if (Array.isArray(message.content)) {
    response = message.content
      .filter((part): part is Extract<OpenAIChatCompletionsContentPart, { type: 'text' }> => part.type === 'text')
      .map(part => ({ type: 'text' as const, text: part.text }));
  }

  return {
    role: 'user',
    parts: [{
      functionResponse: {
        id: message.tool_call_id,
        name: toolNamesById[message.tool_call_id] ?? message.tool_call_id,
        response: { result: response },
      },
    }],
  };
};

const translateUserMessage = (message: OpenAIChatCompletionsMessage): GeminiGenerateContentContent => {
  const parts: GeminiGenerateContentPart[] = [];
  if (typeof message.content === 'string') {
    if (message.content) parts.push(textPart(message.content));
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) parts.push(textPart(part.text));
      } else if (part.type === 'refusal') {
        if (part.refusal) parts.push(textPart(part.refusal));
      } else {
        const media = inlineDataPart(part);
        if (media) parts.push(media);
      }
    }
  }
  return { role: 'user', parts };
};

const translateSystemContent = (content: OpenAIChatCompletionsMessage['content']): GeminiGenerateContentContent | undefined => {
  if (typeof content === 'string') {
    return content ? { parts: [textPart(content)] } : undefined;
  }
  const parts = (content ?? []).filter((part): part is Extract<OpenAIChatCompletionsContentPart, { type: 'text' }> => part.type === 'text').map(part => textPart(part.text));
  return parts.length ? { parts } : undefined;
};

const declarationFromTool = (tool: OpenAIChatCompletionsTool): GeminiGenerateContentFunctionDeclaration => ({
  name: tool.function.name,
  ...(tool.function.description ? { description: tool.function.description } : {}),
  ...(tool.function.parameters !== undefined ? { parameters: klona(tool.function.parameters) } : {}),
});

const buildTools = (payload: OpenAIChatCompletionsPayload): GeminiGenerateContentToolGroup[] | undefined => {
  const tools = payload.tools ?? [];
  if (tools.length === 0) return undefined;
  const declarations = tools.filter(tool => tool.type === 'function').map(declarationFromTool);
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
};

const applyToolChoice = (request: GeminiGenerateContentPayload, toolChoice: NonNullable<OpenAIChatCompletionsPayload['tool_choice']>): void => {
  if (typeof toolChoice === 'string') {
    request.toolConfig = { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : toolChoice === 'required' ? 'ANY' : 'AUTO' } };
    return;
  }
  request.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] } };
};

export const buildTargetRequest = (payload: OpenAIChatCompletionsPayload): GeminiGenerateContentPayload => {
  const request: GeminiGenerateContentPayload = { contents: [] };
  const toolNamesById: ToolCallNamesById = {};
  let lastSystem: GeminiGenerateContentContent | undefined;

  for (const message of payload.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      // A repeated system turn restates the instruction slot; later
      // occurrences win, matching the other reverse translators.
      lastSystem = translateSystemContent(message.content);
      if (lastSystem) request.systemInstruction = lastSystem;
      continue;
    }
    if (message.role === 'assistant') {
      request.contents!.push(translateAssistantMessage(message, toolNamesById));
      continue;
    }
    if (message.role === 'tool') {
      request.contents!.push(translateToolMessage(message, toolNamesById));
      continue;
    }
    request.contents!.push(translateUserMessage(message));
  }

  const generationConfig: NonNullable<GeminiGenerateContentPayload['generationConfig']> = {};
  if (payload.max_tokens !== undefined && payload.max_tokens !== null) generationConfig.maxOutputTokens = payload.max_tokens;
  if (payload.temperature !== undefined && payload.temperature !== null) generationConfig.temperature = payload.temperature;
  if (payload.top_p !== undefined && payload.top_p !== null) generationConfig.topP = payload.top_p;
  if (payload.stop !== undefined && payload.stop !== null) generationConfig.stopSequences = klona(Array.isArray(payload.stop) ? payload.stop : [payload.stop]);
  if (payload.n !== undefined && payload.n !== null) generationConfig.candidateCount = payload.n;
  if (payload.presence_penalty !== undefined && payload.presence_penalty !== null) generationConfig.presencePenalty = payload.presence_penalty;
  if (payload.frequency_penalty !== undefined && payload.frequency_penalty !== null) generationConfig.frequencyPenalty = payload.frequency_penalty;
  if (payload.seed !== undefined && payload.seed !== null) generationConfig.seed = payload.seed;
  if (payload.response_format !== undefined && payload.response_format !== null) {
    generationConfig.responseSchema = klona(payload.response_format);
  }
  if (payload.reasoning_effort != null) {
    // Chat Completions speaks the discrete effort axis; Gemini's numeric
    // thinkingBudget slots do not accept effort names, but thinkingLevel
    // accepts the same tier strings — forward verbatim.
    // https://ai.google.dev/gemini-api/docs/thinking
    generationConfig.thinkingConfig = { thinkingLevel: payload.reasoning_effort };
  }
  request.generationConfig = generationConfig;

  const tools = buildTools(payload);
  if (tools) {
    request.tools = tools;
    if (payload.tool_choice != null) applyToolChoice(request, payload.tool_choice);
  }

  return request;
};