// POST /v1/embeddings — forward embedding requests to Copilot

import type { Context } from "hono";
import { copilotFetch, isCopilotTokenFetchError } from "../../lib/copilot.ts";
import { withAccountFallback } from "../shared/account-pool/fallback.ts";
import {
  apiErrorResponse,
  getErrorMessage,
  proxyJsonResponse,
} from "../shared/http/proxy-response.ts";

export const embeddings = async (c: Context) => {
  try {
    const body = await c.req.text();
    let model = "unknown";
    try {
      const parsed = JSON.parse(body) as { model?: unknown };
      if (typeof parsed.model === "string") model = parsed.model;
    } catch {
      // Let upstream preserve the request-shape error; fallback simply has no model signal.
    }

    const resp = await withAccountFallback(model, ({ account }) =>
      copilotFetch(
        "/embeddings",
        { method: "POST", body },
        account.token,
        account.accountType,
      ));

    return proxyJsonResponse(resp);
  } catch (e: unknown) {
    if (isCopilotTokenFetchError(e)) {
      return new Response(e.body, {
        status: e.status,
        headers: e.headers,
      });
    }

    return apiErrorResponse(c, getErrorMessage(e), 502);
  }
};
