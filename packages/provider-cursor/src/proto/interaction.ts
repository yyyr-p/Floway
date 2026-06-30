import { parseProtoFields } from './decoding.ts';
import { parseToolCallStartedUpdate, parsePartialToolCallUpdate } from './tool-calls.ts';
import type { ParsedInteractionUpdate } from './types.ts';

/**
 * Parse an InteractionUpdate message.
 *
 * InteractionUpdate fields:
 *   field 1: text_delta (TextDeltaUpdate)
 *   field 2: tool_call_started (ToolCallStartedUpdate)
 *   field 3: tool_call_completed (ToolCallCompletedUpdate)
 *   field 4: thinking_delta (ThinkingDeltaUpdate) — reasoning/thinking models
 *   field 7: partial_tool_call (PartialToolCallUpdate)
 *   field 8: token_delta (TokenDeltaUpdate)
 *   field 13: heartbeat
 *   field 14: turn_ended (TurnEndedUpdate)
 */
export function parseInteractionUpdate(data: Uint8Array): ParsedInteractionUpdate {
  const fields = parseProtoFields(data);

  let text: string | null = null;
  let thinking: string | null = null;
  let isComplete = false;
  let isHeartbeat = false;
  let toolCallStarted: ParsedInteractionUpdate['toolCallStarted'] = null;
  let toolCallCompleted: ParsedInteractionUpdate['toolCallCompleted'] = null;
  let partialToolCall: ParsedInteractionUpdate['partialToolCall'] = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const innerFields = parseProtoFields(field.value);
      for (const innerField of innerFields) {
        if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
          text = new TextDecoder().decode(innerField.value);
        }
      }
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parseToolCallStartedUpdate(field.value);
      if (parsed.toolCall) {
        toolCallStarted = {
          callId: parsed.callId,
          modelCallId: parsed.modelCallId,
          toolType: parsed.toolCall.toolType,
          name: parsed.toolCall.name,
          arguments: JSON.stringify(parsed.toolCall.arguments),
        };
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parseToolCallStartedUpdate(field.value);
      if (parsed.toolCall) {
        toolCallCompleted = {
          callId: parsed.callId,
          modelCallId: parsed.modelCallId,
          toolType: parsed.toolCall.toolType,
          name: parsed.toolCall.name,
          arguments: JSON.stringify(parsed.toolCall.arguments),
        };
      }
    } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const innerFields = parseProtoFields(field.value);
      for (const innerField of innerFields) {
        if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
          thinking = new TextDecoder().decode(innerField.value);
        }
      }
    } else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parsePartialToolCallUpdate(field.value);
      partialToolCall = {
        callId: parsed.callId,
        argsTextDelta: parsed.argsTextDelta,
      };
    } else if (field.fieldNumber === 8 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const tokenFields = parseProtoFields(field.value);
      for (const tField of tokenFields) {
        if (tField.fieldNumber === 1 && tField.wireType === 2 && tField.value instanceof Uint8Array) {
          text = new TextDecoder().decode(tField.value);
        }
      }
    } else if (field.fieldNumber === 14) {
      isComplete = true;
    } else if (field.fieldNumber === 13) {
      isHeartbeat = true;
    }
  }

  return { text, thinking, isComplete, isHeartbeat, toolCallStarted, toolCallCompleted, partialToolCall };
}
