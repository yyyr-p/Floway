import {
  normalizeDomainEntry,
} from '../../../../../tools/web-search/domain-normalize.ts';
import {
  type ResponseFunctionTool,
  type ResponseHostedTool,
  type ResponseTool,
  type ResponseToolChoice,
  WEB_SEARCH_HOSTED_TYPE_NAMES,
} from '@floway-dev/protocols/responses';

// Runtime set derived from the canonical tuple declared next to
// `ResponseHostedToolType` so the type union and runtime check can't drift.
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_tool.py
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_preview_tool.py
export const WEB_SEARCH_HOSTED_TYPES: ReadonlySet<string> = new Set<string>(WEB_SEARCH_HOSTED_TYPE_NAMES);

// Function-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the umbrella
// uses the underscored form of the model's training-time `web.run`.
export const SHIM_TOOL_NAME = 'web_search';

export interface ShimToolFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: { city?: string; region?: string; country?: string; timezone?: string };
  maxResults?: number;
}

// Approximates the ~40 results native hosted web_search returns
// regardless of search_context_size; backends bill per call, so larger
// result sets only multiply upstream context-window cost. `medium` is
// the native default (matches openai-python `WebSearchTool.search_context_size`
// docstring: "Defaults to 'medium'") — when the client omits the field
// or sends an explicit `'medium'`, we still pass the corresponding
// maxResults so providers don't fall back to their own (smaller)
// default count.
export const CONTEXT_SIZE_TO_MAX_RESULTS: Record<'low' | 'medium' | 'high', number> = {
  low: 10,
  medium: 20,
  high: 40,
};

const DEFAULT_SEARCH_CONTEXT_SIZE: keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS = 'medium';

export const isValidSearchContextSize = (v: unknown): v is keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS =>
  typeof v === 'string' && v in CONTEXT_SIZE_TO_MAX_RESULTS;

// Both `function` and `custom` client tools share the upstream callable
// namespace (responses-via-* translators wrap `custom` as `function`
// for non-Responses upstreams), so a client tool of either kind named
// `web_search` collides with the umbrella. Returning a resolved name
// (rather than throwing) lets such a client coexist.
export const resolveShimToolName = (declaredCallableTools: Iterable<string>): string => {
  const taken = new Set<string>(declaredCallableTools);
  if (!taken.has(SHIM_TOOL_NAME)) return SHIM_TOOL_NAME;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${SHIM_TOOL_NAME}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('Unable to resolve a free shim umbrella tool name within 1000 attempts');
};

// The hosted tool's `user_location` must surface to the model, not just
// to the backend provider — without this hint the model asks "Which
// city should I check?" even when the client supplied one.
const formatUserLocation = (loc: NonNullable<ShimToolFilters['userLocation']>): string => {
  const parts: string[] = [];
  if (loc.city) parts.push(loc.city);
  if (loc.region && loc.region !== loc.city) parts.push(loc.region);
  if (loc.country) parts.push(loc.country);
  const joined = parts.join(', ');
  if (!loc.timezone) return joined;
  return joined.length === 0 ? `(timezone: ${loc.timezone})` : `${joined} (timezone: ${loc.timezone})`;
};

// `web.run` umbrella shape: 13 sub-properties on a single tool. The
// shim implements 3 (`search_query`, `open`, `find`); the other 10
// surface as per-entry error IRs at dispatch time. The description
// deliberately omits the unsupported ones.
//   https://github.com/openai/harmony/blob/abd677f7ac962629c808197caa1feb9e3e95d2b0/src/chat.rs#L259-L313
const buildUmbrellaTool = (
  name: string,
  userLocation?: ShimToolFilters['userLocation'],
): ResponseFunctionTool => {
  const baseDescription
    = 'Accesses the web through three actions: searching, opening a page, and finding text inside a page. '
    + 'Multiple sub-property arrays may be populated in one call to dispatch several operations in parallel.';
  const hasUserLocation = userLocation !== undefined && (
    (userLocation.city !== undefined && userLocation.city.length > 0)
    || (userLocation.region !== undefined && userLocation.region.length > 0)
    || (userLocation.country !== undefined && userLocation.country.length > 0)
    || (userLocation.timezone !== undefined && userLocation.timezone.length > 0)
  );
  const description = hasUserLocation
    ? `${baseDescription} Default user location: ${formatUserLocation(userLocation)}. Use this as the default when the user asks about local information without specifying a location.`
    : baseDescription;

  return {
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        search_query: {
          type: 'array',
          description: 'Run one or more web searches. Each entry produces an independent search-results list.',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'The search query.' },
            },
            required: ['q'],
            additionalProperties: false,
          },
        },
        open: {
          type: 'array',
          description: 'Fetch the readable text content of fully qualified URLs.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'An HTTP or HTTPS URL.' },
            },
            required: ['ref_id'],
            additionalProperties: false,
          },
        },
        find: {
          type: 'array',
          description: 'Find exact case-insensitive matches of `pattern` inside the page at `ref_id`. Returns up to 10 matches with ~200 characters of surrounding context.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'An HTTP or HTTPS URL of the page to search inside.' },
              pattern: { type: 'string', description: 'Case-insensitive substring to find.' },
            },
            required: ['ref_id', 'pattern'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    // Strict mode requires `required` to list every property, but every
    // sub-property here is optional (one call may set only
    // `search_query`, another only `open`).
    strict: false,
  };
};

export const isHostedWebSearchTool = (tool: ResponseTool): tool is ResponseHostedTool =>
  typeof tool.type === 'string' && WEB_SEARCH_HOSTED_TYPES.has(tool.type);

const extractFilters = (tool: ResponseHostedTool): ShimToolFilters => {
  const out: ShimToolFilters = {};
  if (tool.filters?.allowed_domains) out.allowedDomains = tool.filters.allowed_domains;
  if (tool.filters?.blocked_domains) out.blockedDomains = tool.filters.blocked_domains;
  if (tool.user_location) out.userLocation = tool.user_location;
  // Default to native's documented default (`medium`) when omitted.
  // Without this, a provider-side default (e.g. Tavily's smaller
  // baseline count) would silently shrink the result set on requests
  // that didn't think about search_context_size at all.
  const size = tool.search_context_size ?? DEFAULT_SEARCH_CONTEXT_SIZE;
  out.maxResults = CONTEXT_SIZE_TO_MAX_RESULTS[size as keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS];
  return out;
};

const isHostedToolChoiceType = (toolChoice: ResponseToolChoice | undefined): boolean =>
  typeof toolChoice === 'object'
  && toolChoice !== null
  && typeof toolChoice.type === 'string'
  && WEB_SEARCH_HOSTED_TYPES.has(toolChoice.type);

export interface PreparedTools {
  tools: ResponseTool[];
  filters: ShimToolFilters;
  toolChoice: ResponseToolChoice | undefined;
  /**
   * Name the shim addresses the umbrella under. Computed from declared
   * function tools regardless of whether a hosted web_search was
   * present, because the reverse path (replaying web_search_call input
   * items) needs the name even when no hosted tool exists this turn.
   */
  shimToolName: string;
}

export interface PrepareToolsError {
  /** Human-readable error message; goes into the 400 envelope's `error.message`. */
  message: string;
  /** JSON-Pointer-style location inside `tools[]`; goes into `error.param`. */
  param: string;
}

export type PrepareToolsResult =
  | { ok: true; prepared: PreparedTools }
  | { ok: false; error: PrepareToolsError };

// Per-list cap matches the OpenAI documented "up to 100 allowed_domains
// or up to 100 blocked_domains" limit.
//   https://developers.openai.com/api/docs/guides/tools-web-search.md
const MAX_DOMAIN_LIST_ENTRIES = 100;

// Domain-list entry validator. First-failure-wins: returns at the
// first malformed entry so the 400 envelope names ONE offending
// value. We reject non-string entries with their type description
// (matches native's `invalid_type`-shaped rejection for non-string
// list entries); valid-string-but-bad-host entries reject with a
// simple message naming the value.
const validateDomainListEntry = (
  raw: unknown,
): { ok: true } | { ok: false; message: string } => {
  if (typeof raw !== 'string') {
    return { ok: false, message: `Expected string, got ${raw === null ? 'null' : typeof raw}.` };
  }
  if (raw.trim() === '' || /^https?:\/\//i.test(raw) || /[\s/?#@:]/.test(raw) || normalizeDomainEntry(raw) === null) {
    return { ok: false, message: `Invalid domain '${raw}'` };
  }
  return { ok: true };
};

// Validate the parts of a hosted-web-search entry the shim acts on.
// Anything else (`external_web_access`, `return_token_budget`, etc.)
// is silently dropped along with the hosted tool itself — the shim
// replaces the hosted entry with its umbrella function tool, so any
// hosted-only field the shim doesn't process never reaches upstream
// regardless.
const validateHostedEntry = (tool: ResponseHostedTool): PrepareToolsError | null => {
  const sizeField = (tool as { search_context_size?: unknown }).search_context_size;
  if (sizeField !== undefined && sizeField !== null && !isValidSearchContextSize(sizeField)) {
    return {
      message: `web_search tool search_context_size must be one of ${Object.keys(CONTEXT_SIZE_TO_MAX_RESULTS).map(k => `'${k}'`).join(' | ')}; got ${JSON.stringify(sizeField)}.`,
      param: 'tools[].search_context_size',
    };
  }
  const filtersField = (tool as { filters?: unknown }).filters;
  if (filtersField === undefined || filtersField === null) return null;
  if (typeof filtersField !== 'object' || Array.isArray(filtersField)) {
    return {
      message: `web_search tool filters must be an object; got ${Array.isArray(filtersField) ? 'array' : typeof filtersField}.`,
      param: 'tools',
    };
  }
  for (const field of ['allowed_domains', 'blocked_domains'] as const) {
    const value = (filtersField as Record<string, unknown>)[field];
    // `undefined` and `null` both read as "omit" — same no-op
    // semantics as an empty list.
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      return {
        message: `web_search tool filters.${field} must be an array of strings; got ${typeof value}.`,
        param: 'tools',
      };
    }
    if (value.length > MAX_DOMAIN_LIST_ENTRIES) {
      return {
        message: `web_search tool filters.${field} accepts at most ${MAX_DOMAIN_LIST_ENTRIES} entries; got ${value.length}.`,
        param: 'tools',
      };
    }
    for (const entry of value) {
      const verdict = validateDomainListEntry(entry);
      if (!verdict.ok) {
        return { message: verdict.message, param: 'tools' };
      }
    }
  }
  return null;
};

// Single pass that validates each hosted entry, collects client-
// callable names (for umbrella name collision avoidance), and
// remembers the LAST hosted entry's filters (last-wins so a request
// with conflicting hosted blocks doesn't have to define which one
// "wins" — the most-recent declaration does). The rewrite step then
// injects ONE umbrella at the first hosted-entry slot, drops the
// rest, and passes everything else through unchanged.
export const prepareToolsForShim = (
  tools: ResponseTool[],
  toolChoice: ResponseToolChoice | undefined,
): PrepareToolsResult => {
  let hostedSeen = false;
  let lastHostedFilters: ShimToolFilters = {};
  const clientCallableNames: string[] = [];
  for (const tool of tools) {
    if (isHostedWebSearchTool(tool)) {
      const reject = validateHostedEntry(tool);
      if (reject !== null) return { ok: false, error: reject };
      hostedSeen = true;
      lastHostedFilters = extractFilters(tool);
      continue;
    }
    if (tool.type === 'function' || tool.type === 'custom') {
      clientCallableNames.push(tool.name);
    }
  }

  const shimToolName = resolveShimToolName(clientCallableNames);

  if (!hostedSeen) {
    return { ok: true, prepared: { tools, filters: {}, toolChoice, shimToolName } };
  }

  const rewritten: ResponseTool[] = [];
  let injected = false;
  for (const tool of tools) {
    if (isHostedWebSearchTool(tool)) {
      if (!injected) {
        rewritten.push(buildUmbrellaTool(shimToolName, lastHostedFilters.userLocation));
        injected = true;
      }
      continue;
    }
    rewritten.push(tool);
  }

  const rewrittenChoice: ResponseToolChoice | undefined = isHostedToolChoiceType(toolChoice)
    ? { type: 'function', name: shimToolName }
    : toolChoice;

  return { ok: true, prepared: { tools: rewritten, filters: lastHostedFilters, toolChoice: rewrittenChoice, shimToolName } };
};
