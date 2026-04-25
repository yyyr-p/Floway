// API key management routes

import type { Context } from "hono";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyById,
  listApiKeys,
  renameApiKey,
  rotateApiKey,
} from "../../lib/api-keys.ts";
import { apiKeyToJson } from "./serialize.ts";

export const listKeys = async (c: Context) => {
  const isAdmin = c.get("isAdmin");
  if (isAdmin) {
    const keys = await listApiKeys();
    return c.json(keys.map((k) => apiKeyToJson(k)));
  }
  // Non-admin: return only the caller's own key
  const keyId = c.get("apiKeyId") as string;
  const key = await getApiKeyById(keyId);
  return c.json(key ? [apiKeyToJson(key)] : []);
};

export const createKey = async (c: Context) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }

  const key = await createApiKey(body.name);
  return c.json(apiKeyToJson(key), 201);
};

export const deleteKey = async (c: Context) => {
  const id = c.req.param("id") ?? "";
  const deleted = await deleteApiKey(id);
  if (!deleted) return c.json({ error: "Key not found" }, 404);
  return c.json({ ok: true });
};

export const rotateKey = async (c: Context) => {
  const id = c.req.param("id") ?? "";
  const key = await rotateApiKey(id);
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json(apiKeyToJson(key));
};

export const renameKey = async (c: Context) => {
  const id = c.req.param("id") ?? "";
  const body = await c.req.json<{ name?: string }>();
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }

  const key = await renameApiKey(id, body.name);
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json(apiKeyToJson(key));
};
