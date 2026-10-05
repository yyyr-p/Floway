# 实现计划:Gemini / Antigravity 上游(路线 B:原生 geminiGenerateContent target)

依赖顺序执行;每阶段跑对应包的 typecheck/test。

## Phase 1 合同扩展
1. `packages/protocols/src/common/endpoints.ts` — ModelEndpoints 加 `geminiGenerateContent?: {}`
2. `packages/protocols/src/gemini-generate-content/stream.ts` — 新增 `parseGeminiGenerateContentStream`(SSE → ProtocolFrame;Gemini 无 [DONE],流关闭即 done;error 事件透传为帧)
3. `packages/provider/src/model.ts` — ALL_PROVIDER_KINDS 加 `'gemini'`, `'antigravity'`
4. `packages/provider/src/invocation.ts` — ChatTargetApi 加 `'geminiGenerateContent'`
5. `packages/provider/src/provider.ts` — ProviderInstance 加:
   - `callGeminiGenerateContent(model, body, signal, opts): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>>`
   - `callGeminiGenerateContentCountTokens(model, body, signal, opts): Promise<ProviderCallResult>`
6. `packages/test-utils/src/stubs.ts` — stubProviderModel/stubInternalModel/stubModelCandidate 默认端点加 `geminiGenerateContent: {}`;stubProvider 加两方法 reject

## Phase 2 translate 三个反向对
- `packages/translate/src/anthropic-messages-via-gemini-generate-content/{request,events,translate}.ts`
- `packages/translate/src/openai-chat-completions-via-gemini-generate-content/{...}`
- `packages/translate/src/openai-responses-via-gemini-generate-content/{...}`
- shared helpers 按分类规则落位(target-locked → `via-gemini-generate-content/`;gemini 双向 → `gemini-generate-content-and-*/` 视实际需要;先放 pair 目录,复用时再上提)
- index.ts 导出三函数

## Phase 3 gateway 原生分支
- `shared/target-picker.ts` — 加 `case 'geminiGenerateContent'`
- `gemini-generate-content/attempt.ts` — generate 首选 native:偏好顺序改为 `['geminiGenerateContent','openaiChatCompletions','anthropicMessages','openaiResponses']`;native 分支直调 `callGeminiGenerateContent` + `providerStreamResultToExecuteResult`(新 Gemini billable usage reader)。countTokens 首选 native `geminiGenerateContent`(2xx 直接 relay `{totalTokens}`,非 2xx 转 envelope)
- `gemini-generate-content/usage.ts` — usageMetadata → BillableUsage(参照其他端点 usage.ts)
- `anthropic-messages/attempt.ts`、`openai-chat-completions/attempt.ts`、`openai-responses/attempt.ts` — 各自 serve picker 加 `'geminiGenerateContent'` 优先项 + attempt 加 native 分支 dispatch(带 dump capture)

## Phase 4 packages/provider-gemini(API key 型)
- config.ts / defaults.ts / fetch.ts(`{base}/v1beta/models/{id}:generateContent|:streamGenerateContent?alt=sse|:countTokens`,x-goog-api-key)/ fetch-models.ts(ListModels 过滤 generateContent)/ provider.ts / pricing.ts
- endpoints 仅 `{ geminiGenerateContent: {} }`

## Phase 5 packages/provider-antigravity(OAuth 订阅型)
- constants.ts(OAuth ClientID/Secret/scopes/端点,附引用 URL)/ oauth.ts(authorize/exchange/refresh)+ loopback 粘贴模式
- state.ts(state:credential {providerId, tokens, email};config 无手动态)/ access-token.ts(CAS + in-flight coalescing,仿 claude-code)
- project.ts(loadCodeAssist/onboardUser)/ version.ts(UA 常量起步,fallback 2.9.1)/ envelope.ts(antigravity 包装 + 响应剥离 + terminal 合成 + usage 过滤)/ fetch-available-models.ts + models.ts(静态表)
- fetch.ts / provider.ts

## Phase 6 控制面 + 数据层注册
- registry.ts、schemas.ts(create/update enum)、upstreams/types.ts(三联合 + dashboard)、serialize.ts(三函数)、upstreams/routes.ts(normalizeConfig/stateFromBody/patch 拒绝)、control-plane/routes.ts + upstreams/antigravity.ts(authorize-url/exchange/refresh)、data-transfer/import-schema.ts、迁移 `0086_gemini_antigravity_provider.sql`、saveUpstream/shared.ts 如涉及

## Phase 7 apps/web + i18n + 文档
- provider-badge.tsx(两 SVG + 三表)、upstream-editor/data.ts、provider-config.tsx、page.tsx、dashboard-providers-upstreams.tsx、copyableRecord、signals.tsx、upstream-form 相关、i18n en + zh-Hans、AGENTS.md Index、eslint.config.ts projectList

## Phase 8 测试 + verify
- 各包 `__tests__`(protocols stream、translate 三对最小回路、provider-gemini/antigravity provider 测试、gateway attempt 分支)
- `pnpm verify` 全绿

## Antigravity 线协议备忘(来自调研笔记)
- envelope:`{project, model, userAgent:'antigravity', requestType:'agent', requestId:'agent-<uuid>', request:{...gemini, sessionId}}`
- 端点:`{base}/v1internal:generateContent|:streamGenerateContent?alt=sse|:countTokens|:fetchAvailableModels`;base 默认 daily
- SSE 事件包 `data: {"response": <chunk>}`;删除顶/内层 safetySettings;toolConfig 挪入 request;Claude 模型 toolConfig.mode=VALIDATED、非 Claude 删 maxOutputTokens
- 函数声明 `parameters` → `parametersJsonSchema`;schema 清洗第一版保守剥离(follow-up)
- Usage:非 terminal chunk 的 usageMetadata 改名 cpaUsageMetadata(第一版直接透传 usageMetadata,丢弃 cpaUsageMetadata 舞)
- 无 finishReason 时 [DONE] 合成 STOP terminal chunk