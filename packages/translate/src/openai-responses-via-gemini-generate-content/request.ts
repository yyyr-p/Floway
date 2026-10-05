import { klona } from 'klona/json';

import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-openai-responses-payload.ts';
import { buildCustomToolInputSchema } from '../shared/openai-responses-via/custom-tool-wrap.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../shared/openai-responses-via/namespace-tools.ts';
import { restrictAllowedTools } from '../shared/openai-responses-via/allowed-tools.ts';
import { parseToolArgumentsObject } from '../shared/via-anthropic-messages/tool-arguments.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { OpenAIResponsesRequestPayload } from '@floway-dev/protocols/openai-responses';
import type {
  GeminiGenerateContentContent,
  GeminiGenerateContentFunctionDeclaration,
  GeminiGenerateContentPayload,
  GeminiGenerateContentThinkingConfig,
} from '@floway-dev/protocols/gemini-generate-content';
import type {
  OpenAIResponsesInputContent,
  OpenAIResponsesInputImage,
  OpenAIResponsesInputMessage,
  OpenAIResponsesInputText,
  OpenAIResponsesTool,
  OpenAIResponsesToolChoice,
} from '@floway-dev/protocols/openai-responses';

// Tool-result parts name the call they answer; OpenAI Responses carries only
// the call_id. The request builder records every function_call/call_id → name
// pair while walking the history so the response part can restore the name —
// the same registry the anthropic-messages-via pair keeps for tool_use ids,
// scoped per trip.
interface ToolCallNamesById {
  [id: string]: string;
}

export interface TargetRequestResult {
  target: GeminiGenerateContentPayload;
  namespaceToolNames: NamespaceToolNames;
  // Custom tools are projected onto wrapped function declarations; the events
  // translator reads this set to emit `custom_tool_call` items (and unwrap the
  // `{ input: ... }` envelope) for calls naming a projected tool.
  customToolNames: Set<string>;
}

const textPart = (text: string): { text: string } => ({ text });

const thinkingPart = (text: string): GeminiGenerateContentContent['parts'][number] => ({ text, thought: true });

const inlineDataPart = (part: OpenAIResponsesInputImage): GeminiGenerateContentContent['parts'][number] | null => {
  // Responses image parts point at a URL that may be a remote https
  // resource, which Gemini generateContent carries as fileData — or a base64
  // data: URL, which it carries as inlineData. file_id-only content has no
  // Gemini slot.
  const imageUrl = part.image_url;
  if (typeof imageUrl !== 'string') return null;
  const dataUrl = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(imageUrl);
  if (dataUrl) return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    const mimeType = /\.(jpe?g|png|gif|webp)(\?|$)/i.exec(imageUrl)?.[1];
    return { fileData: { mimeType: mimeType ? `image/${mimeType === 'jpg' ? 'jpeg' : mimeType}` : 'image/jpeg', fileUri: imageUrl } };
  }
  return null;
};

// Responses' system/developer messages and the `instructions` field collapse
// into Gemini's single `systemInstruction`. Repeated slots restated later win
// — later occurrences overwrite, matching the other reverse translators.
const systemFromMessage = (message: OpenAIResponsesInputMessage): GeminiGenerateContentContent | undefined => {
  if (typeof message.content === 'string') return message.content ? { parts: [textPart(message.content)] } : undefined;
  const parts = message.content
    .filter((part): part is OpenAIResponsesInputText => part.type === 'input_text' || part.type === 'output_text')
    .map(part => textPart(part.text));
  return parts.length ? { parts } : undefined;
};

const assistantTextParts = (content: string | OpenAIResponsesInputContent[]): GeminiGenerateContentContent['parts'] => {
  if (typeof content === 'string') return content ? [textPart(content)] : [];
  const parts: GeminiGenerateContentContent['parts'] = [];
  for (const part of content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      if (part.text) parts.push(textPart(part.text));
    } else if (part.type === 'refusal') {
      // Responses carries refusal as its own part; Gemini generateContent has
      // no refusal slot, so the text rides as plain.
      if (part.refusal) parts.push(textPart(part.refusal));
    }
  }
  return parts;
};

const userContentParts = async (content: string | OpenAIResponsesInputContent[]): Promise<GeminiGenerateContentContent['parts']> => {
  if (typeof content === 'string') return content ? [textPart(content)] : [];
  const parts: GeminiGenerateContentContent['parts'] = [];
  for (const part of content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      if (part.text) parts.push(textPart(part.text));
    } else if (part.type === 'refusal') {
      if (part.refusal) parts.push(textPart(part.refusal));
    } else if (part.type === 'input_image') {
      const media = inlineDataPart(part);
      if (media) parts.push(media);
    }
  }
  return parts;
};

const toolOutputParts = async (output: string | OpenAIResponsesInputContent[], callId: string, toolNamesById: ToolCallNamesById): Promise<GeminiGenerateContentContent> => {
  const parts: GeminiGenerateContentContent['parts'] = [];
  if (typeof output === 'string') {
    parts.push({ functionResponse: { id: callId, name: toolNamesById[callId] ?? callId, response: parseToolResponseOutput(output) } });
  } else {
    // Multimodal tool output: text parts ride inside the response object;
    // image parts ride as separate user-role inline parts after the
    // functionResponse. file parts have no Gemini slot.
    const texts: unknown[] = [];
    for (const part of output) {
      if (part.type === 'input_image') {
        const media = inlineDataPart(part);
        if (media) parts.push(media);
      } else if (part.type === 'refusal') {
        texts.push({ type: 'text' as const, text: part.refusal });
      } else {
        texts.push({ type: 'text' as const, text: part.text });
      }
    }
    parts.unshift({ functionResponse: { id: callId, name: toolNamesById[callId] ?? callId, response: { result: texts.length === 1 ? texts[0] : texts } } });
  }
  return { role: 'user', parts };
};

const parseToolResponseOutput = (output: string): unknown => {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
};

const functionCallPart = (item: { call_id: string; name: string; arguments: string }, toolNamesById: ToolCallNamesById): GeminiGenerateContentContent['parts'][number] => ({
  functionCall: { id: item.call_id, name: item.name, args: parseToolArgumentsObject(item.arguments) },
});

const customToolCallPart = (item: { call_id: string; name: string; input: string }, toolNamesById: ToolCallNamesById): GeminiGenerateContentContent['parts'][number] => ({
  // Project the freeform invocation into the wrapped function-tool shape so
  // the translated target sees a coherent tool-call history — matching the
  // other responses-source translators.
  functionCall: { id: item.call_id, name: item.name, args: parseToolArgumentsObject(JSON.stringify({ input: item.input })) },
});

const declarationFromTool = (tool: Extract<OpenAIResponsesTool, { type: 'function' }>): GeminiGenerateContentFunctionDeclaration => ({
  name: tool.name,
  ...(tool.description != null ? { description: tool.description } : {}),
  ...(tool.parameters != null ? { parameters: klona(tool.parameters) } : {}),
});

const translateTools = (tools: OpenAIResponsesTool[] | null | undefined, customToolNames: Set<string>): GeminiGenerateContentPayload['tools'] => {
  const declarations: GeminiGenerateContentFunctionDeclaration[] = [];
  for (const tool of tools ?? []) {
    if (tool.type === 'function') declarations.push(declarationFromTool(tool));
    if (tool.type === 'custom') {
      // The freeform custom tool surfaces as a plain function declaring a
      // single string input — the wrap the call-history projection applies.
      // The name is recorded so the events translator can restore the
      // `custom_tool_call` item identity from a wrapped function call.
      customToolNames.add(tool.name);
      declarations.push({
        name: tool.name,
        ...(tool.description != null ? { description: tool.description } : {}),
        parameters: buildCustomToolInputSchema(tool.format),
      });
    }
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
};

const translateToolChoice = (toolChoice: OpenAIResponsesToolChoice | null | undefined): GeminiGenerateContentPayload['toolConfig'] => {
  if (typeof toolChoice === 'string') {
    return { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : toolChoice === 'required' ? 'ANY' : 'AUTO' } };
  }
  if (toolChoice && (toolChoice.type === 'function' || toolChoice.type === 'custom') && toolChoice.name) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] } };
  }
  return undefined;
};

// Responses speaks the discrete effort axis; Gemini's numeric thinkingBudget
// slots do not accept effort names, but thinkingLevel accepts the same tier
// strings — forward verbatim.
// https://ai.google.dev/gemini-api/docs/thinking
const thinkingConfigFromPayload = (payload: OpenAIResponsesRequestPayload): GeminiGenerateContentThinkingConfig | undefined =>
  payload.reasoning?.effort != null ? { thinkingLevel: payload.reasoning.effort } : undefined;

export const buildTargetRequest = async (source: OpenAIResponsesRequestPayload): Promise<TargetRequestResult> => {
  const { payload, names: namespaceToolNames } = flattenNamespaceTools(canonicalizeOpenAIResponsesPayload(source));

  const request: GeminiGenerateContentPayload = { contents: [] };
  const toolNamesById: ToolCallNamesById = {};
  let system: GeminiGenerateContentContent | undefined;

  if (payload.instructions) {
    // The canonical `instructions` field leads the instruction slot; leading
    // system/developer input messages overwrite it per the later-wins rule.
    system = { parts: [textPart(payload.instructions)] };
    request.systemInstruction = system;
  }

  let pendingAssistant: GeminiGenerateContentContent['parts'] | null = null;
  const flushAssistant = (): void => {
    if (pendingAssistant === null) return;
    if (pendingAssistant.length > 0) request.contents!.push({ role: 'model', parts: pendingAssistant });
    pendingAssistant = null;
  };

  for (const item of payload.input) {
    switch (item.type) {
    case 'message':
      flushAssistant();
      if (item.role === 'assistant') {
        pendingAssistant = assistantTextParts(item.content);
        continue;
      }
      if (item.role === 'system' || item.role === 'developer') {
        system = systemFromMessage(item);
        if (system) request.systemInstruction = system;
        continue;
      }
      request.contents!.push({ role: 'user', parts: await userContentParts(item.content) });
      continue;
    case 'function_call': {
      pendingAssistant ??= [];
      pendingAssistant.push(functionCallPart(item, toolNamesById));
      continue;
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      flushAssistant();
      request.contents!.push(await toolOutputParts(item.output, item.call_id, toolNamesById));
      continue;
    case 'custom_tool_call': {
      pendingAssistant ??= [];
      pendingAssistant.push(customToolCallPart(item, toolNamesById));
      continue;
    }
    case 'reasoning': {
      pendingAssistant ??= [];
      for (const summary of item.summary) {
        if (summary.text) pendingAssistant.push(thinkingPart(summary.text));
      }
      continue;
    }
    case 'item_reference':
      throw new TranslatorInputError("Invalid input item type 'item_reference'.");
    case 'web_search_call':
      // The shim must translate echoed web_search_call input items into
      // function_call + function_call_output pairs before this translator
      // runs. Reaching here means the reverse path was skipped.
      throw new TranslatorInputError("Invalid input item type 'web_search_call'.");
    default:
      // Exhaustiveness guard: a future OpenAIResponsesInputItem variant must
      // explicitly opt into translator behavior.
      throw new TranslatorInputError(`Invalid input item: ${JSON.stringify(item)}`);
    }
  }
  flushAssistant();

  const generationConfig: NonNullable<GeminiGenerateContentPayload['generationConfig']> = {};
  if (payload.max_output_tokens != null) generationConfig.maxOutputTokens = payload.max_output_tokens;
  if (payload.temperature != null) generationConfig.temperature = payload.temperature;
  if (payload.top_p != null) generationConfig.topP = payload.top_p;
  if (payload.presence_penalty != null) generationConfig.presencePenalty = payload.presence_penalty;
  if (payload.frequency_penalty != null) generationConfig.frequencyPenalty = payload.frequency_penalty;
  if (payload.text?.format?.type === 'json_schema' && payload.text.format.schema && typeof payload.text.format.schema === 'object' && !Array.isArray(payload.text.format.schema)) {
    generationConfig.responseSchema = klona(payload.text.format.schema);
  }
  const thinkingConfig = thinkingConfigFromPayload(payload);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  request.generationConfig = generationConfig;

  const allowed = restrictAllowedTools(payload.tools, payload.tool_choice);
  const customToolNames = new Set<string>();
  const tools = translateTools(allowed.tools, customToolNames);
  if (tools) {
    request.tools = tools;
    const toolConfig = translateToolChoice(allowed.choice);
    if (toolConfig) request.toolConfig = toolConfig;
  }

  return { target: request, namespaceToolNames, customToolNames };
};