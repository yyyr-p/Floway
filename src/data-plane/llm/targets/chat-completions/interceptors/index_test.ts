// Order assertion for the Chat Completions target assembler.

import { assertEquals } from "@std/assert";
import { withUsageStreamOptionsIncluded } from "./include-usage-stream-options.ts";
import { withDeepseekReasoningDialect } from "./normalize-reasoning-dialect.ts";
import { withUsageNormalized } from "./normalize-usage.ts";
import { interceptorsForChatCompletions } from "./index.ts";

Deno.test("interceptorsForChatCompletions without provider interceptors: base only", () => {
  const provider = {
    enabledFixes: new Set<string>(),
  };
  assertEquals(
    interceptorsForChatCompletions(provider),
    [withUsageStreamOptionsIncluded, withUsageNormalized],
  );
});

Deno.test("interceptorsForChatCompletions with deepseek dialect enabled", () => {
  const provider = {
    enabledFixes: new Set(["deepseek-reasoning-dialect"]),
  };
  assertEquals(
    interceptorsForChatCompletions(provider),
    [
      withUsageStreamOptionsIncluded,
      withUsageNormalized,
      withDeepseekReasoningDialect,
    ],
  );
});

Deno.test("interceptorsForChatCompletions without enabledFixes: base only", () => {
  const provider = {
    enabledFixes: new Set<string>(),
  };
  assertEquals(
    interceptorsForChatCompletions(provider),
    [withUsageStreamOptionsIncluded, withUsageNormalized],
  );
});
