// All Cursor upstream constants. Do NOT make these operator-configurable —
// the client-version header is part of how Cursor identifies CLI traffic.

// Cursor's backend. RunSSE + BidiAppend both live here in HTTP/1.1 mode.
export const CURSOR_BACKEND_BASE = 'https://api2.cursor.sh';

export const CURSOR_RUN_SSE_PATH = '/agent.v1.AgentService/RunSSE';
export const CURSOR_BIDI_APPEND_PATH = '/aiserver.v1.BidiService/BidiAppend';
export const CURSOR_USABLE_MODELS_PATH = '/aiserver.v1.AiService/GetUsableModels';
// AvailableModels carries the client-facing model tooltips. GetUsableModels
// says which models the account may use; AvailableModels is the only source
// (prose-only) of each model's context window — see fetchCursorAvailableContext.
export const CURSOR_AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels';

// Cursor CLI client version we impersonate on the data plane. Pinned from
// yet-another-opencode-cursor-auth / opencode-cursor-proxy; newer models may
// gate behind a minimal client version, so bump against the latest CLI tag.
export const CURSOR_CLIENT_VERSION = 'cli-2025.11.25-d5b3271';

// connect-es UA — matches what the Cursor CLI's connect-rpc client sends.
export const CURSOR_USER_AGENT = 'connect-es/1.4.0';

export const CURSOR_GRPC_WEB_CONTENT_TYPE = 'application/grpc-web+proto';
