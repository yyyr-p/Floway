/**
 * Cursor Chat Completions data-plane call.
 *
 * Self-constructs a ProviderStreamResult (async generator of
 * ProtocolFrame<ChatCompletionsStreamEvent>) — bypasses streamingProviderCall,
 * which hard-requires a Response+text/event-stream, because Cursor's stream is
 * a synthesized dual-channel (RunSSE read + BidiAppend write) rather than a
 * single SSE body. The gateway's respond.ts re-encodes these frames downstream.
 */

import { ensureCursorAccessToken, mintCursorAccessToken } from './access-token-cache.ts';
import { createAgentTranslator, isComposerModel } from './agent-translate.ts';
import { AgentTransport } from './agent-transport.ts';
import { CursorSessionTerminatedError } from './auth/oauth.ts';
import { generateCursorChecksum } from './checksum.ts';
import { CURSOR_BACKEND_BASE, CURSOR_CLIENT_VERSION } from './constants.ts';
import { getCursorSession, putCursorSession, deleteCursorSession } from './cursor-session-state.ts';
import { AgentMode, type RequestContextEnv, type OpenAIToolDefinition } from './proto/index.ts';
import { isCursorRateLimited } from './quota.ts';
import { deriveSessionKey, mintSessionKey, unwrapToolCallId } from './session-id.ts';
import type { CursorAccountCredential } from './state.ts';
import { getDurableHttpSession, type DurableHttpSessionHandle } from '@floway-dev/platform';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload, ChatCompletionsMessage, ChatCompletionsTool } from '@floway-dev/protocols/chat-completions';
import { eventFrame, doneFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ProviderStreamResult, type UpstreamCallOptions, type UpstreamModel } from '@floway-dev/provider';

export interface CursorCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

interface CursorChatCallBase {
  upstreamId: string;
  account: CursorAccountCredential;
  model: UpstreamModel;
  headers: Headers;
  signal?: AbortSignal;
  effects: CursorCallEffects;
  call: UpstreamCallOptions;
}

export interface CallCursorChatCompletionsOptions extends CursorChatCallBase {
  body: Omit<ChatCompletionsPayload, 'model'>;
}

// Gateway environment reported to Cursor's request_context exec. The gateway
// has no real workspace (it rejects built-in tool exec), so these are stable
// placeholders. timezone is the only operator-relevant value.
const gatewayEnv: RequestContextEnv = {
  workspacePath: '/workspace',
  osVersion: 'darwin 24.0.0',
  shell: '/bin/zsh',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

const mintAccessToken = (opts: CursorChatCallBase, refreshToken: string) =>
  mintCursorAccessToken(refreshToken, opts.call.fetcher, opts.effects.persistRefreshTokenRotation);

// Pre-fetch gates + access-token mint + checksum precompute. The checksum is
// stable within a 30-minute window for a given token, so one precompute per
// turn is correct.
const prepareCursorCall = async (
  opts: CursorChatCallBase,
): Promise<{ ok: true; accessToken: string; checksum: string } | { ok: false; response: Response }> => {
  const wrapSynthetic = (response: Response) => opts.call.recordUpstreamLatency(Promise.resolve(response));

  if (opts.account.state !== 'active') {
    return { ok: false, response: await wrapSynthetic(synthetic503(`Cursor upstream is ${opts.account.state}`)) };
  }

  if (isCursorRateLimited(opts.account.quotaSnapshot?.data ? 429 : 200)) {
    // quota parsing is a placeholder; this branch is unreachable until real
    // 429 headers are captured. Kept so the gate is wired.
    return { ok: false, response: await wrapSynthetic(synthetic429('Cursor upstream rate-limited')) };
  }

  try {
    const entry = await ensureCursorAccessToken(opts.upstreamId, opts.account.userId, refresh => mintAccessToken(opts, refresh));
    const checksum = await generateCursorChecksum(entry.token);
    return { ok: true, accessToken: entry.token, checksum };
  } catch (err) {
    if (err instanceof CursorSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return { ok: false, response: await wrapSynthetic(synthetic503(`Cursor refresh failed: ${err.upstreamMessage}`)) };
    }
    throw err;
  }
};

// Cursor agent is stateless from the gateway's view: each fresh RunSSE carries
// an empty conversation state, so the full transcript is inlined into the
// single user message. System → prefix, history → role-tagged turns.
//
// Tool calling does NOT go through this transcript. Cursor's MCP protocol
// carries tool outputs over the BidiAppend ExecMcpResult write channel on a
// live session (see performCursorSessionFollowUp) — folding a tool result into
// the prompt as "[Tool result] {...}" severely degrades the model (it reads an
// unaddressed JSON blob and either ignores it or re-runs the tool). So we never
// flatten tool results here: role:'tool' messages are dropped, and an assistant
// turn that only carried tool_calls contributes just its own text (if any).
//
// This path serves (a) genuine new conversations and (b) the cold-resume
// fallback when a live session was lost (cross-instance / evicted / CF cold
// start). In case (b) the tools list stays advertised so cursor re-runs the
// agent loop natively — an honest "fresh turn" rather than a degraded prompt
// fold.
const flattenMessages = (messages: ChatCompletionsMessage[]): string => {
  const parts: string[] = [];
  for (const m of messages) {
    // Tool results live on the MCP write channel, never in the transcript.
    if (m.role === 'tool') continue;

    const text = messageText(m);
    if (!text) continue;
    const tag = m.role === 'system' || m.role === 'developer' ? 'System'
      : m.role === 'user' ? 'User'
        : m.role === 'assistant' ? 'Assistant'
          : m.role;
    parts.push(`[${tag}]\n${text}`);
  }

  return parts.join('\n\n');
};

const messageText = (m: ChatCompletionsMessage): string => {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  // An assistant turn carrying only tool_calls (no text) contributes nothing to
  // the transcript — the call itself is replayed natively via the tools list,
  // not narrated into the prompt.
  return '';
};

const toAgentTools = (tools: ChatCompletionsTool[] | null | undefined): OpenAIToolDefinition[] | undefined => {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
    },
  }));
};

const synthetic503 = (message: string): Response =>
  new Response(JSON.stringify({ error: { type: 'cursor_upstream_unavailable', message } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

const synthetic429 = (message: string): Response =>
  new Response(JSON.stringify({ error: { type: 'cursor_rate_limited', message } }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });

export const callCursorChatCompletions = async (
  opts: CallCursorChatCompletionsOptions,
): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
  const ready = await prepareCursorCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, response: ready.response };

  // Session correlation: derive sessionKey from inbound tool_call_id or header.
  const { sessionKey: derived, isFollowUp } = deriveSessionKey(
    opts.upstreamId, opts.call.apiKeyId, opts.headers, opts.body.messages,
  );
  const sessionKey = derived ?? mintSessionKey(opts.upstreamId, opts.call.apiKeyId);

  // Try to reuse an in-process session (tool-call follow-up continuation).
  // Priority: in-process generator cache (Node fast path) > DurableHttpSession
  // broker (CF path, future). If neither hits, fall through to new-session.
  if (isFollowUp) {
    const inProcess = getCursorSession(sessionKey);
    if (inProcess) {
      return await performCursorSessionFollowUp(opts, ready.accessToken, ready.checksum, null, sessionKey);
    }
    try {
      const broker = getDurableHttpSession();
      const session = await broker.acquire(sessionKey, null, { signal: opts.signal });
      if (session) {
        return await performCursorSessionFollowUp(opts, ready.accessToken, ready.checksum, session, sessionKey);
      }
    } catch {
      // broker uninitialized or acquire error → fall through to new-session path
    }
  }

  return await performCursorChatCall(opts, ready.accessToken, ready.checksum, sessionKey);
};

// Build the AgentTransport + self-construct the event stream. The generator:
//   - text/thinking/tool_call_* → translator → eventFrame
//   - mcp exec_request → translator emits tool_calls, then BREAK (stateless
//     passthru: the downstream client returns the tool result in the next
//     turn, which Floway inlines into a fresh RunSSE)
//   - request_context exec → answer with the gateway env, keep streaming
//   - other built-in exec → reject on the write channel, keep streaming
//   - done → finalize (finish_reason) + doneFrame
//   - error → throw (the gateway surfaces a 502)
//
// 401 retry: prepareCursorCall already mints a fresh token, so a 401 here is
// rare. Mid-stream 401 retry is deferred (TODO cursor): the lazy generator
// can't cleanly retry once events have flowed. Step 9 will add a peek-then-
// stream retry once the real 401 shape is captured.
const performCursorChatCall = async (
  opts: CallCursorChatCompletionsOptions,
  accessToken: string,
  checksum: string,
  sessionKey: string,
): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
  const message = flattenMessages(opts.body.messages);
  // Always advertise the tools. On a cold-resume (a tool-result follow-up that
  // missed the live session) this lets cursor re-run the agent loop natively
  // and re-issue the tool call, rather than degrading to a prompt-folded
  // result — see flattenMessages. The native follow-up path
  // (performCursorSessionFollowUp) handles the happy case on the live session.
  const tools = toAgentTools(opts.body.tools);

  // Wrap the proxy-aware Fetcher so per-call latency recording still wraps each
  // outbound RunSSE/BidiAppend, even though transport owns the fetch calls.
  const fetchWrapper = (url: string, init: RequestInit): Promise<Response> =>
    opts.call.fetcher(url, init, opts.call.recordUpstreamLatency);

  const transport = new AgentTransport({
    accessToken,
    baseUrl: CURSOR_BACKEND_BASE,
    env: gatewayEnv,
    clientVersion: CURSOR_CLIENT_VERSION,
    getChecksum: () => checksum,
    fetch: fetchWrapper as unknown as typeof fetch,
  });

  const id = `chatcmpl-cursor-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const translator = createAgentTranslator({
    id,
    model: opts.model.id,
    created,
    composer: isComposerModel(opts.model.id),
    sessionKey,
  });

  // AGENT mode keeps the turn open (the backend expects an agent loop to
  // continue — tool calls, checkpoints — and does not emit turn_ended on a
  // simple reply). ASK mode is the direct Q&A turn shape: the backend emits
  // text then turn_ended, which is what a Chat Completions caller expects.
  // Tool-calling turns stay in AGENT mode so the model can drive its loop.
  const mode = tools && tools.length > 0 ? AgentMode.AGENT : AgentMode.ASK;
  const gen = transport.openChatStream({ message, model: opts.model.id, tools, mode });

  // Kick off the generator before returning ok=true: the first .next() awaits
  // the RunSSE fetch + the initial BidiAppend RunRequest, so the gateway's
  // recordUpstreamLatency wraps a real upstream round-trip. The recorder is
  // asserted at the ok=true boundary in providerStreamResultToExecuteResult,
  // so a fully-lazy generator (fetch deferred until the consumer pulls) would
  // fail that check. The first chunk is held back and re-yielded so streaming
  // stays intact.
  const first = await gen.next();

  const events = async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    let sessionSaved = false;
    try {
      // Pull from gen manually instead of for-await — for-await would call
      // gen.return() on break, killing the transport's RunSSE read. We need
      // the gen to stay alive after a tool_calls break so the next turn can
      // continue reading from it.
      let iterResult = first;
      while (true) {
        if (iterResult.done) break;
        const chunk = iterResult.value;
        if (chunk.type === 'error') {
          throw new Error(chunk.error ?? 'Cursor agent stream error');
        }
        if (chunk.type === 'done') break;

        if (chunk.type === 'exec_request' && chunk.execRequest) {
          const exec = chunk.execRequest;
          if (exec.type === 'mcp') {
            for (const ev of translator.translate(chunk)) yield eventFrame(ev);
            // Save the live session for follow-up tool result continuation.
            // The gen stays open (NOT returned) so the RunSSE read stays alive.
            // Key pendingExecs by the cleaned tool_call_id (no newline) —
            // matches what the translator emits (cleanCallId) and what the
            // client will echo back (after unwrap).
            const cleanedTcId = exec.toolCallId.split('\n')[0]!.trim();
            const pendingExecs = new Map<string, { id: number; execId: string | undefined }>();
            pendingExecs.set(cleanedTcId, { id: exec.id, execId: exec.execId });
            putCursorSession({
              gen,
              sendMcpResult: (id, execId, result) => transport.sendMcpResult({ type: 'mcp', id, execId, name: exec.name, args: exec.args, toolCallId: exec.toolCallId, providerIdentifier: exec.providerIdentifier, toolName: exec.toolName }, result),
              sendResumeAction: () => transport.sendResumeAction(),
              pendingExecs,
              sessionKey,
              lastActivityAt: Date.now(),
            });
            sessionSaved = true;
            break;
          }
          if (exec.type === 'request_context') {
            await transport.sendRequestContextResult(exec.id, exec.execId);
            continue;
          }
          await transport.sendRejectedTool(exec, 'Floway gateway cannot execute built-in tools');
          continue;
        }

        for (const ev of translator.translate(chunk)) yield eventFrame(ev);

        // Advance to the next chunk manually (no for-await, no auto-return).
        iterResult = await gen.next();
      }
    } finally {
      // Only abort the transport if we did NOT save the session for follow-up.
      // When session is saved, the generator stays open for the next turn.
      if (!sessionSaved) {
        await gen.return(undefined);
      }
    }

    for (const ev of translator.finalize()) yield eventFrame(ev);
    yield doneFrame();
  };

  return { ok: true, events: events(), modelKey: opts.model.id };
};

/**
 * Follow-up on an existing in-process session (tool result continuation).
 * The transport's gen is still alive in cursor-session-state; we send
 * ExecMcpResult via the saved transport methods, then sendResumeAction
 * so cursor continues streaming, and pump the gen for the follow-up reply.
 */
const performCursorSessionFollowUp = async (
  opts: CallCursorChatCompletionsOptions,
  _accessToken: string,
  _checksum: string,
  session: DurableHttpSessionHandle | null,
  sessionKey: string,
): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
  // Release the DurableHttpSession handle if present — we use the in-process gen.
  if (session) await session.release();

  const entry = getCursorSession(sessionKey);
  if (!entry) {
    // Session evicted between acquire and here — fallback to new session.
    return await performCursorChatCall(opts, _accessToken, _checksum, sessionKey);
  }

  // Match incoming role:'tool' messages to pending exec requests.
  // Wrap the BidiAppend calls in this request's recordUpstreamLatency so the
  // gateway's recorder sees a real upstream round-trip on this request (not
  // the first request's recorder, which belongs to a different UpstreamCallOptions).
  const toolMessages = opts.body.messages.filter(m => m.role === 'tool' && typeof m.tool_call_id === 'string');

  const sendToolResults = async (): Promise<void> => {
    for (const toolMsg of toolMessages) {
      const wrappedId = toolMsg.tool_call_id!;
      const unwrapped = unwrapToolCallId(wrappedId);
      const pending = entry.pendingExecs.get(unwrapped) ?? entry.pendingExecs.get(wrappedId);
      if (!pending) continue;

      const content = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
      await entry.sendMcpResult(pending.id, pending.execId, { success: { content } });
      entry.pendingExecs.delete(unwrapped);
      entry.pendingExecs.delete(wrappedId);
    }
    // NO ResumeAction: cursor auto-resumes the model turn on the live RunSSE
    // read channel once it receives the mcp_result (matches the validated
    // HTTP/2 reference — see AgentTransport.sendExecResultNoClose). Sending a
    // ResumeAction here makes the server finalize the turn instead, producing
    // an empty follow-up reply.
  };

  // Record the BidiAppend round-trips against THIS request's latency recorder.
  await opts.call.recordUpstreamLatency(sendToolResults());

  // Now pump the gen for the continuation.
  const id = `chatcmpl-cursor-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const translator = createAgentTranslator({
    id,
    model: opts.model.id,
    created,
    composer: isComposerModel(opts.model.id),
    sessionKey,
  });

  // Kick off the first read to satisfy recordUpstreamLatency requirement.
  // The bidiAppend calls above already went through fetcher (latency recorded).
  const first = await entry.gen.next();

  const events = async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    let sessionSavedAgain = false;
    try {
      // Manual pull (NOT for-await): for-await calls entry.gen.return() on
      // break, which kills the transport's RunSSE read and prevents any
      // further tool-result continuation on this session.
      let iterResult = first;
      while (true) {
        if (iterResult.done) break;
        const chunk = iterResult.value;
        if (chunk.type === 'error') {
          deleteCursorSession(sessionKey);
          throw new Error(chunk.error ?? 'Cursor agent stream error');
        }
        if (chunk.type === 'done') break;

        if (chunk.type === 'exec_request' && chunk.execRequest) {
          const exec = chunk.execRequest;
          if (exec.type === 'mcp') {
            for (const ev of translator.translate(chunk)) yield eventFrame(ev);
            // Save again for the next follow-up. Key by the cleaned id (no
            // embedded newline) to match the translator's emitted tool_call_id
            // and what the client echoes back after unwrap.
            const cleanedTcId = exec.toolCallId.split('\n')[0]!.trim();
            entry.pendingExecs.set(cleanedTcId, { id: exec.id, execId: exec.execId });
            entry.lastActivityAt = Date.now();
            sessionSavedAgain = true;
            break;
          }
          if (exec.type === 'request_context') {
            // request_context only appears on the first turn (the agent loop is
            // already bootstrapped on a follow-up). Skip — rare in practice.
            iterResult = await entry.gen.next();
            continue;
          }
          iterResult = await entry.gen.next();
          continue;
        }

        for (const ev of translator.translate(chunk)) yield eventFrame(ev);
        iterResult = await entry.gen.next();
      }
    } finally {
      if (!sessionSavedAgain) {
        deleteCursorSession(sessionKey);
      }
    }

    for (const ev of translator.finalize()) yield eventFrame(ev);
    yield doneFrame();
  };

  return { ok: true, events: events(), modelKey: opts.model.id };
};
