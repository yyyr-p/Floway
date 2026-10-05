# CLIProxyAPI Gemini / Antigravity 上游调研笔记

调研对象:https://github.com/router-for-me/CLIProxyAPI(Go),clone 于 /tmp/CLIProxyAPI(main 快照,2026-10)。

## 总览

CLIProxyAPI 中与 Google 相关的上游有 4 条线:

| Provider key | 凭据 | 上游端点 | 说明 |
|---|---|---|---|
| `gemini` (aka gemini-cli) | Google OAuth(gemini-cli 类型凭据文件)或 API key | `https://generativelanguage.googleapis.com/v1beta` | 官方 Gemini API;OAuth 凭据文件在 load 时被归一为 `gemini-cli`,本快照内 `gemini-cli` 无内置 executor,主要由 plugin 机制接管(file.go:90-91, 155) |
| `gemini-interactions` | 同上 | `generativelanguage.googleapis.com` `/v1beta/interactions`(revision `2026-05-20`) | Gemini 原生 Interactions API |
| `vertex` | Google cloud-platform OAuth / ADC | Vertex AI endpoint | Vertex executor |
| `aistudio` | AI Studio 网页凭据 + WebSocket relay | AI Studio 后端(非公开 API) | 不相关(网页签名) |
| `antigravity` | Google OAuth(专用 ClientID)| `https://{daily-,}cloudcode-pa.googleapis.com/v1internal` | Antigravity IDE 订阅,CloudCode 私有 API |

**Floway 的目标**:为 Floway 实现 Gemini / Antigravity 上游。重点是 antigravity(订阅 OAuth),顺带官方 Gemini(可先做 API key)。

## Antigravity 认证(internal/auth/antigravity)

常量(constants.go):

- ClientID: `<ANTIGRAVITY-OAUTH-CLIENT-ID-SEE-UPSTREAM-constants.go>`
- ClientSecret: `<ANTIGRAVITY-OAUTH-CLIENT-SECRET-SEE-UPSTREAM-constants.go>`
- CallbackPort: 51121,redirect URI `http://localhost:51121/oauth-callback`
- Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`
- OAuth endpoints:标准的 Google OAuth(accounts.google.com / oauth2.googleapis.com/token),userinfo 走 `https://www.googleapis.com/oauth2/v2/userinfo?alt=json`
- API: `https://cloudcode-pa.googleapis.com`(prod)/ `https://daily-cloudcode-pa.googleapis.com`(daily,**请求默认走 daily**,loadCodeAssist 默认 prod),version `v1internal`

OAuth 流程(sdk/auth/antigravity.go):

1. 授权码流程 + loopback callback(支持手动粘贴 callback URL 的 headless 模式)。
2. 换 token → `FetchUserInfo`(拿 email)→ `FetchProjectID`:
   - POST `{APIEndpoint}/v1internal:loadCodeAssist`,body `{"metadata":{"ideType":"ANTIGRAVITY"}}`,UA=`antigravity/hub/<ver>`。
   - 从响应中提取 `cloudaicompanionProject`(兼容 `projectId`/`project`,直接字符串或 `{id}`)+ 默认 tier(`allowedTiers[].isDefault` 或 `currentTier.id`,fallback `free-tier`)。
   - 若无 project:POST `https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser`,body `{"tier_id","metadata":{"ide_type":"ANTIGRAVITY","ide_version","ide_name":"antigravity"}}`,UA 追加 ` google-api-nodejs-client/10.3.0`,带 `X-Goog-Api-Client: gl-node/22.21.1`,轮询 5 次 ×(30s 超时 + 2s 间隔)直到 `done=true`,取 `response.cloudaicompanionProject`。
3. 凭据文件 metadata:`{type:"antigravity", access_token, refresh_token, expires_in, timestamp(unixMilli), expired(RFC3339), email, project_id}`。
4. 刷新:executor `Refresh` → POST `https://oauth2.googleapis.com/token`(grant_type=refresh_token,UA=`Go-http-client/2.0`),按 refresh token single-flight;刷新后 `ensureAntigravityProjectID`。RefreshLead 30 分钟。

版本伪装(internal/misc/antigravity_version.go):

- UA 格式:`antigravity/hub/<version> darwin/arm64`(短,request/loadCodeAssist 用)和短 UA + ` google-api-nodejs-client/10.3.0`(长,onboardUser 用)。
- 版本号每 3h(6h TTL/2)从 `https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml`(electron-builder YAML)拉取;fallback `2.9.1`(Cloud Code 拒绝 < 2.9.0 的客户端)。
- `X-Goog-Api-Client: gl-node/22.21.1` 常量。
- Floway 可以简化为固定 UA 常量(或同样的 manifest 拉取)。

## Antigravity 上游协议

### 请求 URL(executor/antigravity_executor_request.go buildRequest)

- 非流式:`POST {base}/v1internal:generateContent`(base 默认 daily)
- 流式:`POST {base}/v1internal:streamGenerateContent?alt=sse`(`/?$alt=<alt>`)以及 `?$alt=` 变体(responses 等 `alt` 参数)
- CountTokens:`POST {base}/v1internal:countTokens`,payload 里删掉 project/model/safetySettings/toolConfig/labels/sessionId 后直接发送(注意:不包 envelope)
- Headers:仅 `Content-Type: application/json`、`Authorization: Bearer <token>`、`User-Agent: antigravity/hub/<v> darwin/arm64`。HttpRequest 白名单路径还会把入站 headers 全部清掉只剩这些。
- 强制 HTTP/1.1(禁 ALPN/HTTP2)模仿 native client 的 TLS 指纹(TLS 1.3 无 ALPN)。Node 侧 fetch 本来就是 HTTP/1.1,undici 可能需要禁 h2c/ALPN?undici 默认走 HTTP/1.1,无需特殊处理。

### 请求体 envelope(geminiToAntigravity)

Gemini 格式的 payload外面再包一层:

```json
{
  "project": "<projectID>",
  "model": "<modelName>",
  "userAgent": "antigravity",
  "requestType": "agent" | "image_gen" | "web_search",
  "requestId": "agent-<uuid4>" (image: "image_gen/<millis>/<uuid>/12"),
  "request": {
    // 标准 Gemini v1beta generateContentshape:
    // contents[], tools[], systemInstruction, generationConfig, toolConfig...
    "sessionId": "-<随机19位数字或由首个 user 文本 sha256 衍生>",
  }
}
```

要点:
- `requestType` 默认 `agent`(图片模型 `image_gen`)。
- `requestId`:agent → `agent-<UUID>`;image → `image_gen/<unixms>/<uuid>/12`。
- `sessionId` 放在 request 内,取 opts 派生 id;否则首个 user turn 文本 SHA-256 前 8 字节取整型生成稳定 `-<n>`;否则随机。
- 顶层 `safetySettings` 会被删;顶层 `toolConfig` 会挪进 `request.toolConfig`。
- Claude 模型:设置 `request.toolConfig.functionCallingConfig.mode = "VALIDATED"`;非 Claude:删除 `request.generationConfig.maxOutputTokens`(上游不接受/按 entitlement cap)。maxOutputTokens 还会被 cap 到 registry 的 max_completion_tokens。
- 请求内 `request.safetySettings` 删除(geminiToAntigravity 中删一次)。

Gemini 请求 → Antigravity envelope 的 translator(antigravity/gemini/antigravity_gemini_request.go):
- 输入是标准 Gemini v1beta 请求(顶层 contents/tools/systemInstruction/generationConfig)
- `request.model` 删除;`system_instruction` → `systemInstruction`(snake→camel);roles 归一为 user/model;function declarations:`parameters` → `parametersJsonSchema`(注意这是 Gemini 侧 v1beta 用 parametersJsonSchema 的问题反过来了:translator 中是把 incoming `parameters` 改名为 `parametersJsonSchema`,即 **Antigravity 上游接受 parametersJsonSchema 字段**);函数名 sanitize 映射(非字母数字 → 下划线,响应侧 restore)。
- 默认 safety settings 注入(request.safetySettings,5 个 category 全 OFF / BLOCK_NONE)。

### Schema 清洗(antigravity_executor_request.go sanitizeAntigravityRequestSchemas)

- tools 里每个 declarations:`parametersJsonSchema` 重命名回 `parameters`,并用 `CleanJSONSchemaForAntigravityTool` 清洗(useAntigravitySchema = 模型名含 claude|gemini-3-pro|gemini-3.1-pro)。
- generationConfig 的 responseSchema 类似清洗。
- 清洗涉及大量 JSON Schema 关键字(title/format/default/const 等),这是 Antigravity 上游的 schema 兼容性约束。Floway 需要一个等价的 JSON schema sanitizer,或先保守地从 tool declaration 中剥离大多数 non-Gemini-union 关键字。

### 响应(antigravity/gemini/antigravity_gemini_response.go)

上游响应在 `response` 字段下是标准 Gemini chunk。流式 SSE 每行 `data: <json>`,json 是 `{"response": <gemini chunk>}`。

- 流式翻译:剥 `data:` 前缀,取 `response` 字段(alt 分支处理 `$alt=` 数组帧),`[DONE]` 终止。**若上游从未发 finishReason**,在 [DONE] 时合成 terminal chunk:`{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}], usageMetadata, modelVersion, responseId}`。
- usage metadata 的 split:**非 terminal chunk 的 usageMetadata 会被 rename 成 cpaUsageMetadata**,只在 terminal chunk 保留 usageMetadata(客户端兼容性)。
- non-stream:取 `response`,所有 candidate 缺 finishReason 默认补 STOP。
- function names:restore 反向映射。

### 特殊模型路由

Antigravity 上游其实也能跑 Claude/GPT-OSS(模型列表里有 claude-opus-*,gpt-oss-120b 等)。executor 对 `claude* / gemini-3-pro* / gemini-3.1-flash-image` 走一个单独的 executeClaudeNonStream 路径(另一套 translator)。Floway 第一版可以只做 Gemini 模型(纯 Gemini 协议),Claude 后续再说。

### thinking 路径

`request.generationConfig.thinkingConfig.thinkingBudget`(/`includeThoughts`),Claude 走 budget clamp < max_tokens。

### Reasoning replay cache / signature 校验

CLIProxyAPI 有复杂的 thought signature 重放缓存(request.contents 中 thoughtSignature 校验、丢失时用缓存补齐)。Antigravity 的 Gemini 3 系列**会返回 thoughtSignature 且重放需要带回**(`thoughtSignature` field on parts)。Floway 已有类似的 reasoning-id 机制(见 repo 最近的 reasoning 相关提交),第一版可以先原样透传 signature 字段。

### 429/quota 处理

- 短 quota cooldown(SHORT quota → 立即切凭据,retryAfter 带回)
- 全 quota exhausted → credits 兜底(可选)、凭据冷却
- Floway 已有自己的凭据轮询/冷却框架,无需照搬,只需把 429 + retry-after 语义映射过去。

### Model 发现(/v1internal:fetchAvailableModels)

- POST `{base}/v1internal:fetchAvailableModels`,body `{"project":"<project>"}`,UA `antigravity/hub/<v>`。
- 响应:`{"webSearchModelIds":[...], "models":{<modelId>: {...}}}`。
- 能力探测(probing):CLIProxyAPI 用探测请求补 ctx 窗口等;Floway 可以静态 models 表 + fetchAvailableModels 交集/能力标注。

### Antigravity models.json 静态表(截至快照)

`claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `claude-opus-5-5-high`, `claude-sonnet-5-5-high`, `gemini-3.6-flash-high`, `gemini-3.7-flash-high`, `gemini-3.8-flash-high`, `gemini-3-flash`, `gemini-3.1-flash-image`, `gemini-pro-agent`, `gemini-3.1-pro-low`, `gpt-oss-120b-medium`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`。

(注意 Antigravity 暴露的是去 `-low/-high` 后缀之外的 tier 模型 id,`gemini-3.5-flash-low` 这类 ID 在 fetchAvailableModels 中出现,是 tier-specific alias,见 issue #3643/#3699。)

## Gemini 官方 API 侧(CLIProxyAPI gemini executor)

- 端点:`https://generativelanguage.googleapis.com/v1beta`(generateContent / streamGenerateContent?alt=sse / countTokens)
- API key:`x-goog-api-key` header。
- OAuth 型 gemini-cli 凭据:同 endpoint,但 Bearer token + 每请求 UA `gemini-cli/<ver>`(具体见 CLIProxyAPI plugin/vertex;本快照里 OAuth gemini-cli 由 plugin 提供)。**Vertex**: Google cloud-platform OAuth。
- translator:gemini→gemini 只是归一(roles、function declarations camel/snake 互转、schema 清洗、默认 safetySettings)。响应基本透传。

## 对 Floway 实现的建议映射

1. `packages/provider-antigravity`(OAuth 订阅型,类比 provider-copilot/provider-claude-code 的模式):
   - OAuth 授权码 + loopback 回调(端口 51121),Google OAuth client 常量。
   - 登录后 `loadCodeAssist` / `onboardUser` 拿 project_id,email,userinfo。
   - credential 存 `{access_token, refresh_token, expires_at, email, project_id}` + 定时刷新(grant_type=refresh_token)。
   - model 列表:静态表(Gemini tier 模型)∪ fetchAvailableModels。
   - 请求执行:把 Gemini 协议请求包 envelope `{project, model, userAgent:"antigravity", requestType:"agent", requestId, request:{gemini..., sessionId}}` POST daily 端点;SSE 流剥 `response` 包裹;usage 过滤到 terminal;合成 terminal chunk 补 finishReason;429 → retry-after。
   - UA:`antigravity/hub/2.9.1 darwin/arm64` 起步(可选做版本拉取)。
2. `packages/provider-gemini`(API key 型,类比 provider-ollama/provider-custom 模式)x-goog-api-key 直连 generativelanguage v1beta,模型列表用官方 ListModels(或静态)。
3. 翻译层:Floway 的 translate 包若无 Gemini 协议,需要新增 gemini 协议 contract(请求/响应/SSE),客户端协议(openai/anthropic/openai-responses)→ Gemini。这部分是最大工作量。