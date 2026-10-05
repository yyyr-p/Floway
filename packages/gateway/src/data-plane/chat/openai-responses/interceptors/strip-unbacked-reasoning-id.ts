import type { OpenAIResponsesInterceptor } from './types.ts';
import type { OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

// An input reasoning item's id is only the name an upstream filed its signed
// `encrypted_content` under. A reasoning item that arrives with an id but no
// blob is one of two things: a gateway-translated Chat history item whose id
// was synthesized before that synthesis stopped minting ids, or a client's
// own echo of an upstream item the upstream never persisted. Either way no
// upstream can resolve the name: a native Responses upstream treats an
// id-bearing input item as a server-side store reference and rejects the
// whole turn when no row answers —
//
//   "Item with id 'rs_...' not found. Items are not persisted when `store`
//    is set to false. Try again with `store` set to true, or remove this
//    item from your input."
//
// Codex always sends `store: false`, so this is every turn. Official Codex
// resolves the same state by stripping ids from every input item before the
// request leaves the client, and a summary-bearing item without its id is
// still plain history content the upstream accepts. Strip the id here — the
// readable summary stays, which is all of the item a foreign upstream could
// ever consume anyway.
// https://github.com/openai/codex/blob/8c41ed33ce3e39460e7b13b14c35e0c39bb5980d/codex-rs/core/src/client.rs#L911-L921
//
// A reasoning item that still carries `encrypted_content` is untouched: its
// id is the other half of the upstream's signed value, and affinity has
// already decided whether the pair can follow this candidate.
export const withOpenAIResponsesReasoningIdStripped: OpenAIResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'openaiResponses') return run();
  if (!ctx.payload.input.some(isIdBearingBloblessReasoning)) return run();

  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => {
      if (!isIdBearingBloblessReasoning(item)) return item;
      const { id: _id, ...rest } = item as OpenAIResponsesInputItem & { id?: string };
      return rest as OpenAIResponsesInputItem;
    }),
  };
  return run();
};

const isIdBearingBloblessReasoning = (item: OpenAIResponsesInputItem): boolean =>
  item.type === 'reasoning'
  && item.id !== undefined
  && item.id !== null
  && item.encrypted_content === undefined;
