import { assertEquals } from "@std/assert";
import {
  copilotModels,
  jsonResponse,
  requestApp,
  setupAppTest,
  withMockedFetch,
} from "../../../../test-helpers.ts";

const SECOND_ACCOUNT = {
  token: "ghu_second_messages",
  accountType: "individual",
  user: {
    id: 3002,
    login: "second-messages",
    name: "Second Messages",
    avatar_url: "https://example.com/second-messages.png",
  },
};

const messagesResponse = (text: string) =>
  jsonResponse({
    id: "msg_pool",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-pool",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

const requestMessages = (apiKey: string) =>
  requestApp("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model: "claude-pool",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    }),
  });

Deno.test("/v1/messages switches accounts on switchable upstream errors and caches model/account failures", async () => {
  const { repo, apiKey, githubAccount } = await setupAppTest();
  await repo.github.saveAccount(SECOND_ACCOUNT.user.id, SECOND_ACCOUNT);

  const tokenForGithubToken = new Map([
    [githubAccount.token, "copilot-first"],
    [SECOND_ACCOUNT.token, "copilot-second"],
  ]);
  const attempts: string[] = [];

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }

    if (url.pathname === "/copilot_internal/v2/token") {
      const githubToken =
        request.headers.get("authorization")?.replace("token ", "") ?? "";
      return jsonResponse({
        token: tokenForGithubToken.get(githubToken),
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }

    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-pool", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    if (url.pathname === "/v1/messages") {
      const auth = request.headers.get("authorization") ?? "";
      attempts.push(auth);
      if (auth === "Bearer copilot-first") {
        return jsonResponse({ error: { message: "rate limited" } }, 429);
      }
      return messagesResponse("from second account");
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const first = await requestMessages(apiKey.key);
    assertEquals(first.status, 200);
    assertEquals((await first.json()).content[0].text, "from second account");

    const second = await requestMessages(apiKey.key);
    assertEquals(second.status, 200);
    assertEquals((await second.json()).content[0].text, "from second account");
  });

  assertEquals(attempts, [
    "Bearer copilot-first",
    "Bearer copilot-second",
    "Bearer copilot-second",
  ]);
});

Deno.test("/v1/messages clears per-model unavailable cache when every eligible account is cached", async () => {
  const { repo, apiKey, githubAccount } = await setupAppTest();
  await repo.github.saveAccount(SECOND_ACCOUNT.user.id, SECOND_ACCOUNT);

  const tokenForGithubToken = new Map([
    [githubAccount.token, "copilot-first"],
    [SECOND_ACCOUNT.token, "copilot-second"],
  ]);
  const attempts: string[] = [];

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }

    if (url.pathname === "/copilot_internal/v2/token") {
      const githubToken =
        request.headers.get("authorization")?.replace("token ", "") ?? "";
      return jsonResponse({
        token: tokenForGithubToken.get(githubToken),
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }

    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-pool", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    if (url.pathname === "/v1/messages") {
      attempts.push(request.headers.get("authorization") ?? "");
      return jsonResponse({ error: { message: "rate limited" } }, 429);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const first = await requestMessages(apiKey.key);
    assertEquals(first.status, 429);

    const second = await requestMessages(apiKey.key);
    assertEquals(second.status, 429);
  });

  assertEquals(attempts, [
    "Bearer copilot-first",
    "Bearer copilot-second",
    "Bearer copilot-first",
    "Bearer copilot-second",
  ]);
});

Deno.test("/v1/messages switches accounts when Copilot token fetch returns a switchable status", async () => {
  const { repo, apiKey, githubAccount } = await setupAppTest();
  await repo.github.saveAccount(SECOND_ACCOUNT.user.id, SECOND_ACCOUNT);

  const attempts: string[] = [];

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }

    if (url.pathname === "/copilot_internal/v2/token") {
      const githubToken =
        request.headers.get("authorization")?.replace("token ", "") ?? "";
      if (githubToken === githubAccount.token) {
        return jsonResponse({ message: "account not entitled" }, 403);
      }
      return jsonResponse({
        token: "copilot-second-token-stage",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }

    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-pool", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    if (url.pathname === "/v1/messages") {
      attempts.push(request.headers.get("authorization") ?? "");
      return messagesResponse("from token fallback account");
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestMessages(apiKey.key);
    assertEquals(response.status, 200);
    assertEquals(
      (await response.json()).content[0].text,
      "from token fallback account",
    );
  });

  assertEquals(attempts, ["Bearer copilot-second-token-stage"]);
});

Deno.test("/v1/messages preserves Copilot token fetch error headers", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }

    if (url.pathname === "/copilot_internal/v2/token") {
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-reset": "4102444800",
        },
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestMessages(apiKey.key);
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("x-ratelimit-reset"), "4102444800");
  });
});
