import { assertEquals } from "@std/assert";
import { runOnModel, skipProvider } from "./run.ts";
import type { Model, ModelProvider, UpstreamModel } from "./types.ts";

const fail = (): never => {
  throw new Error("unexpected provider call");
};

const provider = (_id: string): ModelProvider => ({
  getProvidedModels: fail,
  callChatCompletions: fail,
  callResponses: fail,
  callMessages: fail,
  callMessagesCountTokens: fail,
  callEmbeddings: fail,
});

const upstreamModel = (id: string): UpstreamModel => ({
  id,
  name: id,
  version: id,
  object: "model",
  capabilities: {
    family: id,
    type: "chat",
    limits: {},
    supports: {},
  },
  supportedEndpoints: [],
});

const modelWithProviders = (...providers: ModelProvider[]): Model => ({
  id: "model-a",
  name: "model-a",
  version: "model-a",
  object: "model",
  capabilities: {
    family: "model-a",
    type: "chat",
    limits: {},
    supports: {},
  },
  supportedEndpoints: [],
  providers: providers.map((modelProvider) => ({
    upstream: `test:${providers.indexOf(modelProvider)}`,
    provider: modelProvider,
    upstreamModel: upstreamModel(`test:${providers.indexOf(modelProvider)}`),
    enabledFixes: new Set(),
  })),
});

Deno.test("runOnModel skips providers that cannot serve this request shape", async () => {
  const first = provider("first");
  const second = provider("second");

  const result = await runOnModel(
    modelWithProviders(first, second),
    (binding) =>
      Promise.resolve(
        binding.provider === first
          ? skipProvider(new Response("unsupported", { status: 400 }))
          : new Response("ok"),
      ),
  );

  assertEquals(result.status, 200);
  assertEquals(await result.text(), "ok");
});

Deno.test("runOnModel returns skipped-provider error when no provider is eligible", async () => {
  const result = await runOnModel(
    modelWithProviders(provider("first"), provider("second")),
    () =>
      Promise.resolve(
        skipProvider(new Response("unsupported", { status: 400 })),
      ),
  );

  assertEquals(result.status, 400);
  assertEquals(await result.text(), "unsupported");
});

Deno.test("runOnModel returns the first eligible provider result", async () => {
  const first = provider("first");
  const second = provider("second");
  let secondCalled = false;

  const result = await runOnModel(
    modelWithProviders(first, second),
    (binding) => {
      if (binding.provider === second) secondCalled = true;
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    },
  );

  assertEquals(result.status, 429);
  assertEquals(await result.text(), "rate limited");
  assertEquals(secondCalled, false);
});
