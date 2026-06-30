/**
 * Cursor Agent transport — HTTP/1.1 dual-channel driver.
 *
 * RunSSE (server-streaming read) + BidiAppend (unary write) over plain fetch,
 * no node:http2. Workers + Node dual-target. Produces AgentStreamChunk events
 * consumed by agent-translate; the caller bridges those into Floway's
 * ProviderStreamResult.
 *
 * Workers-clean: crypto.randomUUID, bytesToHex, Uint8Array fetch bodies,
 * DecompressionStream for gzip. Environment facts come via RequestContextEnv.
 */

import {
  bytesToHex,
  addConnectEnvelope,
  readConnectFrame,
  isTrailerFrame,
  isCompressedFrame,
  parseTrailerMetadata,
  decompressGzip,
  parseProtoFields,
  parseInteractionUpdate,
  parseExecServerMessage,
  parseKvServerMessage,
  analyzeBlobData,
  extractAssistantContent,
  buildKvClientMessage,
  buildAgentClientMessageWithKv,
  buildExecClientMessageWithMcpResult,
  buildExecClientMessageWithShellResult,
  buildExecClientMessageWithLsResult,
  buildExecClientMessageWithRequestContextResult,
  buildExecClientMessageWithReadResult,
  buildExecClientMessageWithGrepResult,
  buildExecClientMessageWithWriteResult,
  buildExecClientMessageWithRejectedTool,
  buildAgentClientMessageWithExec,
  buildExecClientControlMessage,
  buildAgentClientMessageWithExecControl,
  encodeBidiRequestId,
  encodeBidiAppendRequest,
  buildRequestContext,
  encodeUserMessage,
  encodeUserMessageAction,
  encodeConversationAction,
  encodeModelDetails,
  encodeAgentRunRequest,
  encodeAgentClientMessage,
  encodeConversationActionWithResume,
  encodeAgentClientMessageWithConversationAction,
  AgentMode,
  type AgentStreamChunk,
  type AgentChatRequest,
  type ExecRequest,
  type KvServerMessage,
  type McpResult,
  type RequestContextEnv,
} from './proto/index.ts';

const RUN_SSE_PATH = '/agent.v1.AgentService/RunSSE';
const BIDI_APPEND_PATH = '/aiserver.v1.BidiService/BidiAppend';
const USER_AGENT = 'connect-es/1.4.0';
const GRPC_WEB_PROTO = 'application/grpc-web+proto';

const MAX_BLOB_STORE_SIZE = 64;

const DEFAULT_HEARTBEAT = {
  // No progress yet: be conservative — close fast if the backend stalls before
  // first output so we don't burn a Workers subrequest on a dead turn.
  idleBeforeProgressMs: 30_000,
  maxBeforeProgress: 15,
  // After first output: the turn ends authoritatively on the IU[14] turn_ended
  // frame (or an exec pause). This idle window is only a stall safety net for a
  // genuinely wedged upstream that stops sending turn_ended AND stops streaming
  // — kept generous so a long mid-answer reasoning pause (which emits
  // heartbeats) is never mistaken for the end.
  idleAfterProgressMs: 30_000,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export interface AgentTransportOptions {
  accessToken: string;
  baseUrl: string;
  env: RequestContextEnv;
  clientVersion: string;
  /** Privacy/ghost-mode toggle sent as x-ghost-mode. */
  privacyMode?: boolean;
  /** Supplies the x-cursor-checksum header (pure-compute, see checksum.ts). */
  getChecksum: () => string;
  /** Optional fetch injection (tests / per-upstream proxy). Defaults to global. */
  fetch?: typeof fetch;
  /** BidiAppend retry count for transient network errors. Default 1. */
  maxRetries?: number;
  requestTimeoutMs?: number;
  heartbeat?: Partial<typeof DEFAULT_HEARTBEAT>;
}

const RETRYABLE_NETWORK_HINTS = [
  'socket',
  'connection',
  'econnreset',
  'etimedout',
  'epipe',
  'network',
  'fetch',
];

function isRetryableNetworkError(message: string): boolean {
  const lower = message.toLowerCase();
  return RETRYABLE_NETWORK_HINTS.some(hint => lower.includes(hint));
}

/**
 * Cursor Agent dual-channel transport. One instance per chat turn — the blob
 * store and seqno are turn-scoped and cleared on openChatStream.
 */
export class AgentTransport {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly env: RequestContextEnv;
  private readonly clientVersion: string;
  private readonly privacyMode: boolean;
  private readonly getChecksum: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly heartbeat: typeof DEFAULT_HEARTBEAT;

  private readonly blobStore = new Map<string, Uint8Array>();
  private readonly blobStoreOrder: string[] = [];

  // Turn-scoped state, valid while openChatStream is running.
  private currentRequestId: string | null = null;
  private currentAppendSeqno = 0n;
  private controller: AbortController | null = null;

  constructor(opts: AgentTransportOptions) {
    this.accessToken = opts.accessToken;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.env = opts.env;
    this.clientVersion = opts.clientVersion;
    this.privacyMode = opts.privacyMode ?? true;
    this.getChecksum = opts.getChecksum;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 1;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.heartbeat = { ...DEFAULT_HEARTBEAT, ...opts.heartbeat };
  }

  private getHeaders(requestId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      'content-type': GRPC_WEB_PROTO,
      'user-agent': USER_AGENT,
      'x-cursor-checksum': this.getChecksum(),
      'x-cursor-client-version': this.clientVersion,
      'x-cursor-client-type': 'cli',
      'x-cursor-timezone': this.env.timezone,
      'x-ghost-mode': this.privacyMode ? 'true' : 'false',
      // Ask the backend to stream text back over RunSSE instead of stashing
      // assistant responses in KV blobs.
      'x-cursor-streaming': 'true',
    };
    if (requestId) headers['x-request-id'] = requestId;
    return headers;
  }

  private blobIdToKey(blobId: Uint8Array): string {
    return bytesToHex(blobId);
  }

  private storeBlob(key: string, data: Uint8Array): void {
    const existingIndex = this.blobStoreOrder.indexOf(key);
    if (existingIndex !== -1) this.blobStoreOrder.splice(existingIndex, 1);

    while (this.blobStore.size >= MAX_BLOB_STORE_SIZE && this.blobStoreOrder.length > 0) {
      const oldestKey = this.blobStoreOrder.shift();
      if (oldestKey) this.blobStore.delete(oldestKey);
    }

    this.blobStore.set(key, data);
    this.blobStoreOrder.push(key);
  }

  private clearBlobStore(): void {
    this.blobStore.clear();
    this.blobStoreOrder.length = 0;
  }

  /**
   * POST one AgentClientMessage on the BidiAppend write channel. Retries
   * transient network errors up to maxRetries with exponential backoff.
   */
  async bidiAppend(requestId: string, appendSeqno: bigint, data: Uint8Array): Promise<void> {
    const hexData = bytesToHex(data);
    const appendRequest = encodeBidiAppendRequest(hexData, requestId, appendSeqno);
    const envelope = addConnectEnvelope(appendRequest);
    const url = `${this.baseUrl}${BIDI_APPEND_PATH}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: this.getHeaders(requestId),
          body: envelope as BodyInit,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
        }

        // Drain the (usually empty) response body.
        await response.arrayBuffer();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isRetryableNetworkError(lastError.message) && attempt < this.maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 4000);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error('BidiAppend failed with unknown error');
  }

  private buildChatMessage(request: AgentChatRequest): Uint8Array {
    const messageId = crypto.randomUUID();
    const conversationId = request.conversationId ?? crypto.randomUUID();
    const model = request.model ?? 'gpt-4o';
    const mode = request.mode ?? AgentMode.AGENT;

    const requestContext = buildRequestContext(this.env, request.tools);
    const userMessage = encodeUserMessage(request.message, messageId, mode);
    const userMessageAction = encodeUserMessageAction(userMessage, requestContext);
    const conversationAction = encodeConversationAction(userMessageAction);
    const modelDetails = encodeModelDetails(model);
    const agentRunRequest = encodeAgentRunRequest(
      conversationAction,
      modelDetails,
      conversationId,
      request.tools,
      this.env.workspacePath,
    );
    return encodeAgentClientMessage(agentRunRequest);
  }

  private async handleKvMessage(kvMsg: KvServerMessage, requestId: string): Promise<bigint> {
    const seqno = this.currentAppendSeqno;

    if (kvMsg.messageType === 'get_blob_args' && kvMsg.blobId) {
      const key = this.blobIdToKey(kvMsg.blobId);
      const data = this.blobStore.get(key);
      const result = data ?? new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'get_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      await this.bidiAppend(requestId, seqno, responseMsg);
      return seqno + 1n;
    }

    if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
      const key = this.blobIdToKey(kvMsg.blobId);
      this.storeBlob(key, kvMsg.blobData);

      const result = new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'set_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      await this.bidiAppend(requestId, seqno, responseMsg);
      return seqno + 1n;
    }

    return seqno;
  }

  /**
   * Send an ExecClientMessage result then the stream-close control frame.
   * Used by every tool-result path (mcp, rejected built-in, request_context).
   */
  private async sendExecAndClose(id: number, execId: string | undefined, execClientMessage: Uint8Array): Promise<void> {
    if (!this.currentRequestId) throw new Error('No active chat stream — cannot send exec result');

    const responseMsg = buildAgentClientMessageWithExec(execClientMessage);
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno += 1n;

    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno += 1n;
  }

  /**
   * Send an ExecClientMessage result WITHOUT a stream-close control frame.
   * Cursor's MCP protocol treats a single mcp_result as the complete tool
   * output and auto-resumes the model turn on the same RunSSE read channel —
   * an extra exec-stream-close (or a ResumeAction) makes the server finalize
   * the turn instead of continuing, yielding an empty follow-up reply. This
   * mirrors the validated HTTP/2 reference (OmniRoute cursorSessionManager
   * .sendToolResult → encodeExecMcpResult, single frame, no close/resume).
   */
  private async sendExecResultNoClose(execClientMessage: Uint8Array): Promise<void> {
    if (!this.currentRequestId) throw new Error('No active chat stream — cannot send exec result');
    const responseMsg = buildAgentClientMessageWithExec(execClientMessage);
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno += 1n;
  }

  /**
   * Reply to an MCP exec request with a result. Single frame, no close — the
   * server resumes the model turn automatically (see sendExecResultNoClose).
   */
  async sendMcpResult(execRequest: Extract<ExecRequest, { type: 'mcp' }>, result: McpResult): Promise<void> {
    const execClientMsg = buildExecClientMessageWithMcpResult(execRequest.id, execRequest.execId, result);
    await this.sendExecResultNoClose(execClientMsg);
  }

  /** Reject a built-in tool request so the model can adapt and keep streaming. */
  async sendRejectedTool(execRequest: ExecRequest, reason: string): Promise<void> {
    const execClientMsg = buildExecClientMessageWithRejectedTool(execRequest, reason);
    await this.sendExecAndClose(execRequest.id, execRequest.execId, execClientMsg);
  }

  /** Answer a request_context exec with the gateway environment. */
  async sendRequestContextResult(id: number, execId: string | undefined): Promise<void> {
    const execClientMsg = buildExecClientMessageWithRequestContextResult(id, execId, this.env);
    await this.sendExecAndClose(id, execId, execClientMsg);
  }

  async sendShellResult(
    id: number,
    execId: string | undefined,
    command: string,
    cwd: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    executionTimeMs?: number,
  ): Promise<void> {
    const execClientMsg = buildExecClientMessageWithShellResult(id, execId, command, cwd, stdout, stderr, exitCode, executionTimeMs);
    await this.sendExecAndClose(id, execId, execClientMsg);
  }

  async sendLsResult(id: number, execId: string | undefined, filesString: string): Promise<void> {
    const execClientMsg = buildExecClientMessageWithLsResult(id, execId, filesString);
    await this.sendExecAndClose(id, execId, execClientMsg);
  }

  async sendReadResult(
    id: number,
    execId: string | undefined,
    content: string,
    path: string,
    totalLines?: number,
    fileSize?: bigint,
    truncated?: boolean,
  ): Promise<void> {
    const execClientMsg = buildExecClientMessageWithReadResult(id, execId, content, path, totalLines, fileSize, truncated);
    await this.sendExecAndClose(id, execId, execClientMsg);
  }

  async sendGrepResult(id: number, execId: string | undefined, pattern: string, path: string, files: string[]): Promise<void> {
    const execClientMsg = buildExecClientMessageWithGrepResult(id, execId, pattern, path, files);
    await this.sendExecAndClose(id, execId, execClientMsg);
  }

  async sendWriteResult(
    id: number,
    execId: string | undefined,
    result: { success?: { path: string; linesCreated: number; fileSize: number; fileContentAfterWrite?: string }; error?: { path: string; error: string } },
  ): Promise<void> {
    const execClientMsg = buildExecClientMessageWithWriteResult(id, execId, result);
    await this.sendExecAndClose(id, execId, execClientMsg);
  }

  /** Tell the backend to resume streaming after tool results. */
  async sendResumeAction(): Promise<void> {
    if (!this.currentRequestId) throw new Error('No active chat stream — cannot send resume action');
    const conversationAction = encodeConversationActionWithResume();
    const agentClientMessage = encodeAgentClientMessageWithConversationAction(conversationAction);
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, agentClientMessage);
    this.currentAppendSeqno += 1n;
  }

  /** Abort the active RunSSE read (e.g. after yielding a tool_calls chunk). */
  abort(): void {
    this.controller?.abort();
  }

  /**
   * Drive a full chat turn over the dual channel: open RunSSE, send the
   * RunRequest on BidiAppend, then pump AgentServerMessage frames as
   * AgentStreamChunk events until turn_ended / idle-timeout / abort / error.
   *
   * The caller drives exec_request disposition: on an mcp exec it typically
   * translates to a downstream tool_calls chunk and breaks (aborting the
   * read); on a built-in exec it calls sendRejectedTool / sendRequestContextResult
   * and lets the loop continue.
   */
  async *openChatStream(request: AgentChatRequest): AsyncGenerator<AgentStreamChunk> {
    this.clearBlobStore();
    const requestId = crypto.randomUUID();
    this.currentRequestId = requestId;
    this.currentAppendSeqno = 0n;

    const messageBody = this.buildChatMessage(request);

    let lastProgressAt = Date.now();
    let heartbeatSinceProgress = 0;
    let hasProgress = false;
    const markProgress = (): void => {
      heartbeatSinceProgress = 0;
      lastProgressAt = Date.now();
      hasProgress = true;
    };

    const bidiRequestId = encodeBidiRequestId(requestId);
    const envelope = addConnectEnvelope(bidiRequestId);
    const sseUrl = `${this.baseUrl}${RUN_SSE_PATH}`;

    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), this.requestTimeoutMs);

    const pendingAssistantBlobs: Array<{ blobId: string; content: string }> = [];
    let hasStreamedText = false;

    try {
      // ssePromise is intentionally kicked off without await so we can fire the
      // initial BidiAppend RunRequest concurrently. Without an immediate .catch
      // attached, a rejection (DNS failure, connection refused, abort) that
      // resolves before the later `await ssePromise` surfaces as an
      // unhandledRejection — Node 25 escalates that to a process exit. Attach
      // a noop catch so the rejection is observed; the real await below still
      // sees the same error.
      const ssePromise = this.fetchFn(sseUrl, {
        method: 'POST',
        headers: this.getHeaders(requestId),
        body: envelope as BodyInit,
        signal: this.controller.signal,
      });
      ssePromise.catch(() => {});

      // Send the initial RunRequest on the write channel, concurrent with RunSSE.
      // BidiAppend can fail for the same reasons RunSSE can (DNS, abort, refused);
      // any rejection here is caught by the outer try below, but we surface it
      // as an error chunk before falling out so the consumer sees a clean event
      // instead of a thrown promise.
      try {
        await this.bidiAppend(requestId, this.currentAppendSeqno, messageBody);
        this.currentAppendSeqno += 1n;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', error: `BidiAppend initial RunRequest failed: ${message}` };
        return;
      }

      const sseResponse = await ssePromise;
      if (!sseResponse.ok) {
        const errorText = await sseResponse.text();
        yield { type: 'error', error: `SSE stream failed: ${sseResponse.status} - ${errorText}` };
        return;
      }
      if (!sseResponse.body) {
        yield { type: 'error', error: 'No response body from SSE stream' };
        return;
      }

      const reader = sseResponse.body.getReader();
      let buffer = new Uint8Array(0);
      let turnEnded = false;

      try {
        while (!turnEnded) {
          const { done, value } = await reader.read();
          if (done) {
            yield { type: 'done' };
            break;
          }
          if (!value) continue;

          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          let offset = 0;
          // Parse as many complete connect frames as the buffer currently holds.

          while (true) {
            const frame = readConnectFrame(buffer, offset);
            if (!frame) break;
            offset = frame.nextOffset;

            let payload = frame.payload;
            if (isCompressedFrame(frame.flags)) {
              try {
                payload = await decompressGzip(frame.payload);
              } catch {
                // leave payload compressed; field parsing will likely skip it
              }
            }

            if (isTrailerFrame(frame.flags)) {
              const trailer = new TextDecoder().decode(payload);
              const meta = parseTrailerMetadata(trailer);
              const grpcStatus = Number(meta['grpc-status'] ?? '0');
              if (grpcStatus !== 0) {
                const grpcMessage = meta['grpc-message'] ? decodeURIComponent(meta['grpc-message']) : 'Unknown gRPC error';
                yield { type: 'error', error: `${grpcMessage} (grpc-status ${grpcStatus})` };
              }
              continue;
            }

            const serverMsgFields = parseProtoFields(payload);
            for (const field of serverMsgFields) {
              try {
                if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const parsed = parseInteractionUpdate(field.value);

                  if (parsed.text) {
                    hasStreamedText = true;
                    markProgress();
                    yield { type: 'text', content: parsed.text };
                  }
                  if (parsed.thinking) {
                    markProgress();
                    yield { type: 'thinking', content: parsed.thinking };
                  }
                  if (parsed.toolCallStarted) {
                    markProgress();
                    yield {
                      type: 'tool_call_started',
                      toolCall: {
                        callId: parsed.toolCallStarted.callId,
                        modelCallId: parsed.toolCallStarted.modelCallId,
                        toolType: parsed.toolCallStarted.toolType,
                        name: parsed.toolCallStarted.name,
                        arguments: parsed.toolCallStarted.arguments,
                      },
                    };
                  }
                  if (parsed.toolCallCompleted) {
                    markProgress();
                    yield {
                      type: 'tool_call_completed',
                      toolCall: {
                        callId: parsed.toolCallCompleted.callId,
                        modelCallId: parsed.toolCallCompleted.modelCallId,
                        toolType: parsed.toolCallCompleted.toolType,
                        name: parsed.toolCallCompleted.name,
                        arguments: parsed.toolCallCompleted.arguments,
                      },
                    };
                  }
                  if (parsed.partialToolCall) {
                    markProgress();
                    yield {
                      type: 'partial_tool_call',
                      toolCall: {
                        callId: parsed.partialToolCall.callId,
                        toolType: 'partial',
                        name: 'partial',
                        arguments: '',
                      },
                      partialArgs: parsed.partialToolCall.argsTextDelta,
                    };
                  }
                  if (parsed.isComplete) {
                    // InteractionUpdate field 14 (turn_ended) — cursor's
                    // authoritative end-of-turn marker. Verified on the wire to
                    // arrive after the final answer text (after the closing KV
                    // checkpoints and the field-17 usage update). This is the
                    // signal we close the session on; everything below is a
                    // stall-safety fallback, not a normal end path.
                    turnEnded = true;
                  }
                  if (parsed.isHeartbeat) {
                    heartbeatSinceProgress++;
                    const idleMs = Date.now() - lastProgressAt;
                    if (hasProgress) {
                      // The model has already produced output. Heartbeats here
                      // are keep-alives during cursor's own pauses (KV
                      // checkpointing, the gap before turn_ended, mid-answer
                      // reasoning). They must NOT preempt the turn_ended frame —
                      // a raw beat count would truncate short answers whose
                      // turn_ended lags a beat or two behind the last text
                      // (observed). So after progress we only close on a long
                      // *time* idle (a genuine upstream stall), never on count.
                      if (idleMs >= this.heartbeat.idleAfterProgressMs) {
                        turnEnded = true;
                      } else {
                        yield { type: 'heartbeat' };
                      }
                    } else if (heartbeatSinceProgress >= this.heartbeat.maxBeforeProgress || idleMs >= this.heartbeat.idleBeforeProgressMs) {
                      // Before any output: a stream that never produces is
                      // detected by either a beat count or an idle window.
                      turnEnded = true;
                    } else {
                      yield { type: 'heartbeat' };
                    }
                  }
                } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  // conversation_checkpoint_update — NOT a completion signal;
                  // exec_server_message can follow. Just mark progress.
                  markProgress();
                  yield { type: 'checkpoint' };
                } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const execRequest = parseExecServerMessage(field.value);
                  if (execRequest) {
                    markProgress();
                    yield { type: 'exec_request', execRequest };
                  }
                } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const kvMsg = parseKvServerMessage(field.value);
                  if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
                    const key = this.blobIdToKey(kvMsg.blobId);
                    const analysis = analyzeBlobData(kvMsg.blobData);
                    for (const item of extractAssistantContent(analysis, key)) {
                      pendingAssistantBlobs.push(item);
                    }
                  }
                  // kv_server_message: cursor checkpointing conversation state
                  // (it pushes set_blob frames for us to store, and get_blob
                  // frames to re-read on a follow-up). NOT a turn-end signal —
                  // turn termination is the authoritative IU[14] turn_ended
                  // frame (or an exec pause), which always arrives after the
                  // closing KV checkpoints. We answer KV here (blob store) so
                  // the model can finish; a stalled reply pins the seqno and
                  // wedges the whole turn (see handleKvMessage).
                  try {
                    // Assign the returned next-seqno back: handleKvMessage sends
                    // a kv_client_message on the shared BidiAppend channel and
                    // returns seqno+1. Dropping the return value pinned the
                    // seqno, so multiple blob requests in one turn (common on a
                    // tool-result follow-up, where cursor re-fetches conversation
                    // blobs) all replied at the same seqno — cursor ignores the
                    // duplicates, the blob channel stalls, and the model emits an
                    // empty continuation.
                    this.currentAppendSeqno = await this.handleKvMessage(kvMsg, requestId);
                  } catch (kvErr) {
                    const msg = kvErr instanceof Error ? kvErr.message : String(kvErr);
                    if (isRetryableNetworkError(msg)) {
                      yield { type: 'error', error: `Network error during KV: ${msg}` };
                      turnEnded = true;
                    }
                    // non-network KV errors: swallow, keep streaming
                  }
                } else if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  markProgress();
                  yield { type: 'exec_server_abort' };
                } else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const queryFields = parseProtoFields(field.value);
                  let queryId = 0;
                  let queryType = 'unknown';
                  for (const qf of queryFields) {
                    if (qf.fieldNumber === 1 && qf.wireType === 0) queryId = Number(qf.value);
                    else if (qf.fieldNumber === 2) queryType = 'web_search';
                    else if (qf.fieldNumber === 3) queryType = 'ask_question';
                    else if (qf.fieldNumber === 4) queryType = 'switch_mode';
                    else if (qf.fieldNumber === 5) queryType = 'exa_search';
                    else if (qf.fieldNumber === 6) queryType = 'exa_fetch';
                  }
                  markProgress();
                  yield { type: 'interaction_query', queryId, queryType };
                }
              } catch (parseErr) {
                const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                if (isRetryableNetworkError(msg)) {
                  yield { type: 'error', error: `Network error: ${msg}` };
                  turnEnded = true;
                } else {
                  yield { type: 'error', error: `Parse error in field ${field.fieldNumber}: ${msg}` };
                }
              }
            }

            if (turnEnded) break;
          }
          buffer = buffer.slice(offset);
        }

        if (turnEnded) {
          this.controller?.abort();
          if (!hasStreamedText && pendingAssistantBlobs.length > 0) {
            for (const blob of pendingAssistantBlobs) {
              yield { type: 'kv_blob_assistant', blobContent: blob.content };
            }
          }
          yield { type: 'done' };
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err: unknown) {
      const error = err as Error & { name?: string };
      if (error.name === 'AbortError') return; // normal termination
      yield { type: 'error', error: error.message || String(err) };
    } finally {
      clearTimeout(timeout);
      this.controller?.abort();
      this.currentRequestId = null;
    }
  }
}
