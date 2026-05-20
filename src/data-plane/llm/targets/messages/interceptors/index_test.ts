// Order assertion for the Messages target assembler: base ++ copilot ++
// optional. The dispatcher (runTargetInterceptors) executes whatever order
// the assembler returns, so this is the contract guarding interceptor
// ordering across future refactors.

import { assertEquals } from "@std/assert";
import { messagesCopilotInterceptors } from "./copilot/index.ts";
import { withReasoningDisabledOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice.ts";
import {
  interceptorsForMessages,
  messagesOptionalInterceptors,
} from "./index.ts";

Deno.test("interceptorsForMessages on provider with Copilot interceptors: provider interceptors only", () => {
  const provider = {
    enabledFixes: new Set<string>(),
    targetInterceptors: { messages: messagesCopilotInterceptors },
  };
  const assembled = interceptorsForMessages(provider);

  assertEquals(assembled, [...messagesCopilotInterceptors]);
});

Deno.test("interceptorsForMessages on provider without provider interceptors or opt-ins: empty assembly", () => {
  const provider = {
    enabledFixes: new Set<string>(),
  };
  const assembled = interceptorsForMessages(provider);

  assertEquals(assembled, []);
  for (const interceptor of messagesCopilotInterceptors) {
    assertEquals(
      assembled.includes(interceptor),
      false,
      "providers must not pick up Copilot-only interceptors unless they attach them",
    );
  }
});

Deno.test("interceptorsForMessages picks up disable-reasoning-on-forced-tool-choice when opted in", () => {
  const provider = {
    enabledFixes: new Set(["disable-reasoning-on-forced-tool-choice"]),
  };
  assertEquals(
    interceptorsForMessages(provider),
    [withReasoningDisabledOnForcedToolChoice],
  );
});

Deno.test("messagesOptionalInterceptors registers disable-reasoning-on-forced-tool-choice", () => {
  const descriptor = messagesOptionalInterceptors.find(
    (d) => d.fixId === "disable-reasoning-on-forced-tool-choice",
  );
  if (!descriptor) throw new Error("expected interceptor to be registered");
});
