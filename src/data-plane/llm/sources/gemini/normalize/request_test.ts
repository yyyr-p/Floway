import { assertEquals } from "@std/assert";
import type { GeminiGenerateContentRequest } from "../../../../../lib/gemini-types.ts";
import { normalizeGeminiRequest } from "./request.ts";

Deno.test("normalizeGeminiRequest strips unsupported part fields and preserves supported fields", () => {
  const payload: GeminiGenerateContentRequest = {
    contents: [{
      role: "user",
      parts: [{
        text: "hello",
        thought: true,
        thoughtSignature: "thought-signature",
        inlineData: { mimeType: "image/png", data: "aW1hZ2U=" },
        functionCall: { id: "call-1", name: "lookup", args: { query: "deno" } },
        functionResponse: {
          id: "call-1",
          name: "lookup",
          response: { ok: true },
        },
        fileData: { mimeType: "text/plain", fileUri: "gs://bucket/file.txt" },
        executableCode: { language: "python", code: "print(1)" },
        codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" },
      }],
    }],
    systemInstruction: {
      parts: [{
        text: "system",
        fileData: { mimeType: "text/plain", fileUri: "gs://bucket/system.txt" },
      }],
    },
  };

  normalizeGeminiRequest(payload);

  assertEquals(payload, {
    contents: [{
      role: "user",
      parts: [{
        text: "hello",
        thought: true,
        thoughtSignature: "thought-signature",
        inlineData: { mimeType: "image/png", data: "aW1hZ2U=" },
        functionCall: { id: "call-1", name: "lookup", args: { query: "deno" } },
        functionResponse: {
          id: "call-1",
          name: "lookup",
          response: { ok: true },
        },
      }],
    }],
    systemInstruction: {
      parts: [{ text: "system" }],
    },
  });
});

Deno.test("normalizeGeminiRequest removes parts that only contain unsupported file or code fields", () => {
  const payload: GeminiGenerateContentRequest = {
    contents: [{
      role: "user",
      parts: [{
        fileData: { mimeType: "text/plain", fileUri: "gs://bucket/file.txt" },
      }, {
        text: "keep me",
      }, {
        executableCode: { language: "python", code: "print(1)" },
        codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" },
      }],
    }],
    systemInstruction: {
      parts: [{
        fileData: { mimeType: "text/plain", fileUri: "gs://bucket/system.txt" },
      }, {
        text: "system",
      }],
    },
  };

  normalizeGeminiRequest(payload);

  assertEquals(payload, {
    contents: [{
      role: "user",
      parts: [{ text: "keep me" }],
    }],
    systemInstruction: {
      parts: [{ text: "system" }],
    },
  });
});

Deno.test("normalizeGeminiRequest strips unsupported tool capabilities and removes empty tool groups", () => {
  const payload: GeminiGenerateContentRequest = {
    tools: [{
      functionDeclarations: [{
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      }],
      googleSearch: {},
      googleSearchRetrieval: {},
      codeExecution: {},
      computerUse: {},
      urlContext: {},
      fileSearch: {},
      mcpServers: [{ name: "server" }],
      googleMaps: {},
    }, {
      googleSearch: {},
    }, {
      codeExecution: {},
    }],
  };

  normalizeGeminiRequest(payload);

  assertEquals(payload, {
    tools: [{
      functionDeclarations: [{
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      }],
    }],
  });
});

Deno.test("normalizeGeminiRequest removes safety settings without inventing missing defaults", () => {
  const payload: GeminiGenerateContentRequest = {
    cachedContent: "cachedContents/example",
    safetySettings: [{
      category: "HARM_CATEGORY_DANGEROUS_CONTENT",
      threshold: "BLOCK_ONLY_HIGH",
    }],
  };

  normalizeGeminiRequest(payload);

  assertEquals(payload, {
    cachedContent: "cachedContents/example",
  });
});
