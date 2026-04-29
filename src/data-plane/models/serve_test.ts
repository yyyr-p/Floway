import { assertEquals } from "@std/assert";
import {
  copilotModels,
  jsonResponse,
  requestApp,
  setupAppTest,
  withMockedFetch,
} from "../../test-helpers.ts";

const SECOND_ACCOUNT = {
  token: "ghu_second",
  accountType: "individual",
  user: {
    id: 2002,
    login: "second",
    name: "Second Account",
    avatar_url: "https://example.com/second.png",
  },
};

Deno.test("/v1/models returns the ordered union of every connected GitHub account", async () => {
  const { repo, apiKey, githubAccount } = await setupAppTest();
  await repo.github.saveAccount(SECOND_ACCOUNT.user.id, SECOND_ACCOUNT);

  const tokenForGithubToken = new Map([
    [githubAccount.token, "copilot-first"],
    [SECOND_ACCOUNT.token, "copilot-second"],
  ]);

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
      const auth = request.headers.get("authorization");
      if (auth === "Bearer copilot-first") {
        return jsonResponse(copilotModels([
          { id: "shared-model", supported_endpoints: ["/v1/messages"] },
          { id: "first-only", supported_endpoints: ["/responses"] },
        ]));
      }

      if (auth === "Bearer copilot-second") {
        return jsonResponse(copilotModels([
          { id: "shared-model", supported_endpoints: ["/chat/completions"] },
          { id: "second-only", supported_endpoints: ["/v1/messages"] },
        ]));
      }
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/models", {
      headers: { "x-api-key": apiKey.key },
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.data.map((model: { id: string }) => model.id), [
      "shared-model",
      "first-only",
      "second-only",
    ]);
    assertEquals(body.data[0].supported_endpoints, ["/v1/messages"]);
  });
});

Deno.test("/v1/models returns the last real error when every account model load fails", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }

    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-invalid-models",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }

    if (url.pathname === "/models") {
      return jsonResponse({ object: "unexpected", data: [] });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/models", {
      headers: { "x-api-key": apiKey.key },
    });

    assertEquals(response.status, 502);
    assertEquals(await response.json(), {
      error: {
        message: "Invalid Copilot models response",
        type: "api_error",
      },
    });
  });
});
