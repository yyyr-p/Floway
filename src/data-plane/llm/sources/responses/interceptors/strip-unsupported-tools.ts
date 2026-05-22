import type { ResponsesPayload } from '../../../../shared/protocol/responses.ts';
import type { LlmTargetApi, ResponsesInterceptor } from '../../../interceptors.ts';

// Hosted Responses tool entries the gateway cannot yet execute or translate.
// Codex emits `web_search`, `image_generation`, `tool_search`, and `namespace`
// entries under `type` alongside ordinary `function` tools. Keep stripping
// those at the source boundary until the gateway owns an execution shim for
// them.
//
// Freeform `custom` tools are valid native Responses tools and Copilot accepts
// Codex's grammar-shaped `apply_patch` directly. They still cannot be projected
// into Anthropic Messages or Chat Completions function schemas, so the strip
// pass removes `custom` only when the selected target is translated.
//
// Once the source-owned web-search shim grows a Responses entry-point we can
// drop `web_search` from this set and let the shim execute it.
//
// References:
// - https://platform.openai.com/docs/guides/tools-image-generation
// - https://github.com/openai/codex/blob/ed80e5f5583d85e6f61d6839842c50b5c0630d1d/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9-L27
// - https://github.com/caozhiyuan/copilot-api/blob/1d21b4aca31f89ad49a0c3bf1a71e3561d445855/src/routes/responses/handler.ts#L167-L184
const HOSTED_RESPONSES_TOOL_TYPES = new Set(['image_generation', 'web_search', 'tool_search', 'namespace']);

const isUnsupportedToolType = (type: unknown, targetApi: LlmTargetApi): type is string =>
  typeof type === 'string' && (HOSTED_RESPONSES_TOOL_TYPES.has(type) || (targetApi !== 'responses' && type === 'custom'));

const stripToolChoice = (payload: ResponsesPayload, targetApi: LlmTargetApi, removedUnsupportedTool: boolean): void => {
  const choice = payload.tool_choice;

  if (choice && typeof choice === 'object' && isUnsupportedToolType(choice.type, targetApi)) {
    delete payload.tool_choice;
    return;
  }

  if (removedUnsupportedTool && choice === 'required' && (!Array.isArray(payload.tools) || payload.tools.length === 0)) {
    delete payload.tool_choice;
  }
};

/**
 * Strip Responses tool entries the selected target cannot honor after target
 * planning. Native Responses can receive custom tools directly; translated
 * Messages and Chat Completions targets can only receive function-shaped tools.
 *
 * Forced tool choices that target a removed entry are dropped along with it.
 * If every tool was removed and the caller forced `required`, drop the choice
 * too — leaving it would force the upstream to invoke a tool that no longer
 * exists.
 */
export const stripUnsupportedToolsFromPayload = (payload: ResponsesPayload, targetApi: LlmTargetApi): void => {
  let removedUnsupportedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter(tool => {
      const unsupported = isUnsupportedToolType(tool.type, targetApi);
      removedUnsupportedTool ||= unsupported;
      return !unsupported;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  stripToolChoice(payload, targetApi, removedUnsupportedTool);
};

export const stripUnsupportedTools: ResponsesInterceptor = (ctx, _request, run) => {
  stripUnsupportedToolsFromPayload(ctx.payload, ctx.targetApi);
  return run();
};
