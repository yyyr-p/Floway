import type {
  GeminiGenerateContentRequest,
  GeminiPart,
  GeminiToolGroup,
} from "../../../../../lib/gemini-types.ts";

export const normalizeGeminiRequest = (
  payload: GeminiGenerateContentRequest,
): void => {
  // Gemini file/code parts have no current equivalent in the upstream target graph.
  // Drop them at source normalize so every Gemini route target sees translatable parts.
  payload.contents?.forEach((content) =>
    content.parts = stripUnsupportedPartFields(content.parts)
  );
  if (payload.systemInstruction) {
    payload.systemInstruction.parts = stripUnsupportedPartFields(
      payload.systemInstruction.parts,
    );
  }

  stripUnsupportedTools(payload);
  // Gemini safety controls are source-specific and have no matching upstream control.
  delete payload.safetySettings;
};

const stripUnsupportedPartFields = (parts: GeminiPart[]): GeminiPart[] =>
  parts.filter((part) => {
    delete part.fileData;
    delete part.executableCode;
    delete part.codeExecutionResult;

    return Object.keys(part).length > 0;
  });

const stripUnsupportedTools = (payload: GeminiGenerateContentRequest): void => {
  if (!payload.tools) return;

  const tools = payload.tools.filter((tool) => {
    stripUnsupportedToolCapabilities(tool);
    return tool.functionDeclarations && tool.functionDeclarations.length > 0;
  });

  if (tools.length === 0) {
    delete payload.tools;
  } else {
    payload.tools = tools;
  }
};

const stripUnsupportedToolCapabilities = (tool: GeminiToolGroup): void => {
  // Only function declarations are currently translatable from Gemini tool groups.
  // TODO: Support Gemini googleSearch through the existing web-search shim instead of dropping it here.
  delete tool.googleSearch;
  delete tool.googleSearchRetrieval;
  delete tool.codeExecution;
  delete tool.computerUse;
  delete tool.urlContext;
  delete tool.fileSearch;
  delete tool.mcpServers;
  delete tool.googleMaps;
};
