import { assertEquals } from "@std/assert";
import {
  copilotModels,
  jsonResponse,
  setupAppTest,
  withMockedFetch,
} from "../../test-helpers.ts";
import { resolveModelForRequest } from "./registry.ts";

Deno.test("resolveModelForRequest applies provider-owned aliases only to that provider", async () => {
  const { githubAccount, repo } = await setupAppTest();

  await repo.upstreamConfigs.save({
    id: "up_custom",
    name: "Custom Provider",
    baseUrl: "https://custom.example.com",
    bearerToken: "sk-custom",
    supportedEndpoints: ["/v1/messages"],
    enabled: true,
    sortOrder: 100,
    createdAt: "2026-05-01T00:00:00.000Z",
    enabledFixes: [],
  });

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (
      url.hostname === "api.githubcopilot.com" && url.pathname === "/models"
    ) {
      return jsonResponse(copilotModels([
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (
      url.hostname === "custom.example.com" && url.pathname === "/v1/models"
    ) {
      return jsonResponse({
        object: "list",
        data: [{ id: "claude-opus-4-7" }],
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const resolved = await resolveModelForRequest(
      "claude-opus-4-7-20251001",
    );

    assertEquals(resolved.id, "claude-opus-4-7");
    assertEquals(resolved.model?.supportedEndpoints, [
      "messages",
      "messages_count_tokens",
    ]);
    assertEquals(
      resolved.model?.providers.map(({ upstream }) => upstream),
      [`copilot:${githubAccount.user.id}`],
    );
  });
});
