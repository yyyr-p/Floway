# Gemini and Antigravity upstream research

Baseline: Floway upstream/main c7e4d782763b010e44ba243588f2c83c90c97335.

Primary implementation sources inspected on 2026-10-06:

- [CLIProxyAPI a4acc9f](https://github.com/router-for-me/CLIProxyAPI/tree/a4acc9f752bd46571f737a10c04bf413656ab06b): Gemini executor, Antigravity authentication, request envelope and Gemini response adapter.
- [Gemini CLI fb972b2](https://github.com/google-gemini/gemini-cli/tree/fb972b2f87fe7d5b06d37eac711490162d98de2c): code_assist OAuth, setup, server and converter.
- [Gemini generateContent API](https://ai.google.dev/api/generate-content) and [models API](https://ai.google.dev/api/models).
- [LiteLLM Gemini adapter](https://github.com/BerriAI/litellm/tree/main/litellm/llms/gemini) for general gateway comparison. CLIProxyAPI supplies the subscription/Copilot gateway comparison.

## Wire contracts

Gemini API keys authenticate using x-goog-api-key against the Generative Language v1beta API. Model discovery exposes supportedGenerationMethods and input/output limits; capabilities must follow those methods rather than model-name guesses. Streaming requests use streamGenerateContent?alt=sse; token counting uses countTokens.

Gemini CLI uses its installed application's Google OAuth client, offline refresh tokens, and cloudcode-pa.googleapis.com/v1internal methods. Generation envelopes contain model, project, user_prompt_id and request. The Gemini payload stays inside request. SSE events carry response; the traceId may supply responseId. countTokens has its own request contract.

Antigravity has a different installed OAuth client and extra cclog/experimentsandconfigs scopes. Its Cloud Code generation envelope carries model, project, userAgent=antigravity, requestType=agent, requestId and request.sessionId. CLIProxyAPI uses the production Cloud Code endpoint for project discovery. Preserve failure responses and do not guess a project identifier.

## Integration decisions

Add a native Gemini target to Floway's existing protocol graph. Native requests retain Gemini fields that translation-only source interceptors previously stripped. Usage is measured before translation. Keep Google authentication and envelope knowledge in a Google provider package. API-key models are discovered; subscription catalogs are operator configured where no verified catalog contract is available.

Do not copy CLIProxyAPI's model-name heuristics, synthetic successful terminal events, silent credential fallbacks or blanket schema rewrites. Floway must expose incomplete/malformed upstream streams and original HTTP failures. Keep opaque thought signatures bound to the emitting model/upstream.

## Verification limits

Source research establishes wire contracts, not account eligibility. Tests must exercise recorded/constructed wire fixtures, including errors and cancellation. A real Google account smoke test requires an operator-provided configured upstream; no live credential is assumed.
