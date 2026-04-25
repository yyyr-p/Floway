import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { serveChatCompletions } from "./data-plane/sources/chat-completions/serve.ts";
import { models } from "./routes/models.ts";
import { serveMessages } from "./data-plane/sources/messages/serve.ts";
import { embeddings } from "./routes/embeddings.ts";
import { serveResponses } from "./data-plane/sources/responses/serve.ts";
import { countTokens } from "./routes/count-tokens.ts";
import { mountControlPlane } from "./control-plane/routes.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { usageMiddleware } from "./middleware/usage.ts";

export const app = new Hono();

app.use("*", logger());
app.use("*", cors());
app.use("*", authMiddleware);
app.use("*", usageMiddleware);

mountControlPlane(app);

app.post("/v1/chat/completions", serveChatCompletions);
app.post("/chat/completions", serveChatCompletions);
app.get("/v1/models", models);
app.get("/models", models);
app.post("/v1/embeddings", embeddings);
app.post("/embeddings", embeddings);
app.post("/v1/responses", serveResponses);
app.post("/responses", serveResponses);

app.post("/v1/messages", serveMessages);
app.post("/messages", serveMessages);
app.post("/v1/messages/count_tokens", countTokens);
app.post("/messages/count_tokens", countTokens);
