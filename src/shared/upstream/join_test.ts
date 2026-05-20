import { assertEquals, assertFalse } from "@std/assert";
import { joinBaseAndPath, validateUpstreamPath } from "./join.ts";

Deno.test("validateUpstreamPath accepts a leading-slash absolute path", () => {
  const result = validateUpstreamPath("/v1/messages", "messages");
  assertEquals(result, { ok: true, value: "/v1/messages" });
});

Deno.test("validateUpstreamPath trims surrounding whitespace", () => {
  const result = validateUpstreamPath("  /api/v1/chat  ", "chat");
  assertEquals(result, { ok: true, value: "/api/v1/chat" });
});

Deno.test("validateUpstreamPath rejects non-string input", () => {
  const result = validateUpstreamPath(42, "chat");
  assertFalse(result.ok);
});

Deno.test("validateUpstreamPath rejects empty string", () => {
  const result = validateUpstreamPath("", "chat");
  assertFalse(result.ok);
});

Deno.test("validateUpstreamPath rejects paths without a leading slash", () => {
  const result = validateUpstreamPath("v1/chat/completions", "chat");
  assertFalse(result.ok);
});

Deno.test("validateUpstreamPath rejects double slashes", () => {
  const result = validateUpstreamPath("/api//v1/chat", "chat");
  assertFalse(result.ok);
});

Deno.test("validateUpstreamPath rejects relative segments", () => {
  for (
    const bad of [
      "/api/./chat",
      "/api/../chat",
    ]
  ) {
    const result = validateUpstreamPath(bad, "chat");
    assertFalse(result.ok, `expected ${bad} to be rejected`);
  }
});

Deno.test("joinBaseAndPath strips trailing base slashes", () => {
  assertEquals(
    joinBaseAndPath("https://oai.example.com//", "/v1/chat"),
    "https://oai.example.com/v1/chat",
  );
});

Deno.test("joinBaseAndPath preserves a base subpath", () => {
  assertEquals(
    joinBaseAndPath("https://host.example/api", "/v1/messages"),
    "https://host.example/api/v1/messages",
  );
});
