import {
  type InterceptedFunctionCall,
  type UmbrellaSlot,
} from './consume-turn.ts';
import {
  budgetExhaustedText,
  emitWebSearchCallLifecycleStart,
  emptyUmbrellaArgsText,
  findInPageIr,
  findNoMatchesText,
  ITERATION_CAP,
  iterationCapText,
  openFailedText,
  openPageIr,
  schemaErrorIr,
  searchFailedText,
  searchIr,
  synthesizeWebSearchCallId,
  truncatePreservingCodePoints,
  truncationSentinel,
  type WebSearchCallIR,
} from './ir.ts';
import { type MergeState } from './merge-state.ts';
import type { ShimToolFilters } from './tool-rewrite.ts';
import {
  parseUmbrellaOperations,
  type ParsedUmbrella,
  type ShimLogicalOperation,
  unsupportedSubPropertyText,
  wrongTypeSubPropertyText,
} from './umbrella-args.ts';
import {
  normalizeDomainList,
} from '../../../../../tools/web-search/domain-normalize.ts';
import {
  fetchPageAndRecordUsage,
  fetchPageWithoutRecordingUsage,
} from '../../../../../tools/web-search/fetch-page.ts';
import {
  searchWebAndRecordUsage,
  searchWebWithoutRecordingUsage,
} from '../../../../../tools/web-search/search.ts';
import type {
  ConfiguredWebSearchProvider,
  WebSearchProvider,
  WebSearchProviderName,
} from '../../../../../tools/web-search/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponseWebSearchResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

interface PageCacheEntry {
  content: string;
  truncated: boolean;
  fullContentBytes: number;
  title?: string;
}

export interface ShimState {
  filters: ShimToolFilters;
  // Per-request cache shared across `open` and `find` so a find op can
  // reuse a body the model already opened without a second fetch.
  pageCache: Map<string, PageCacheEntry>;
  iterationCount: number;
  // Memoized lazy resolver. The first backend dispatch pays the
  // load+resolve cost; later dispatches reuse the cached result.
  // Replay-only paths (echoed `web_search_call` input with no hosted
  // tool emission) never call this, so an unconfigured search provider
  // does not 500 the request.
  getProvider: () => Promise<ConfiguredWebSearchProvider>;
  // `undefined` for keyless requests (admin playground); usage
  // recording is skipped in that case.
  apiKeyId: string | undefined;
  // Set when the client passed
  // `include: ["web_search_call.action.sources"]` on the request,
  // mirroring native Responses' opt-in shape for the search-action
  // sources list. Native gates the field on this include token; the
  // shim follows suit so the wire shape matches.
  includeSearchActionSources: boolean;
  // Aborted when the downstream client disconnects. Threaded through
  // every backend provider call so a cancelled request stops
  // generating upstream load instead of running to completion.
  downstreamAbortSignal?: AbortSignal;
  // Client-supplied `max_tool_calls` mutable remaining budget.
  // `undefined` means no enforcement. Each consumed umbrella
  // decrements; reaching <= 0 causes the dispatcher to short-circuit
  // backend dispatch and synthesize the iteration-cap-style snippet
  // IR instead. The current value is also written onto the next-turn
  // upstream `max_tool_calls` so any upstream that natively honors
  // the field sees a consistent shrinking budget.
  remainingToolCalls: number | undefined;
}

type FetchAndCacheResult =
  | { ok: true; cached: PageCacheEntry }
  | { ok: false; output: string };

// Suffix-match per Tavily and Microsoft Grounding search-side filter
// semantics: `example.com` matches `example.com`, `www.example.com`,
// and `sub.example.com`, but NOT `evil-example.com`.
const matchesAnyDomain = (hostname: string, domains: readonly string[]): boolean => {
  for (const d of domains) {
    if (hostname === d) return true;
    if (hostname.endsWith(`.${d}`)) return true;
  }
  return false;
};

export const isUrlAllowed = (url: string, filter: ShimToolFilters): boolean => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const blocked = normalizeDomainList(filter.blockedDomains);
  if (blocked.length > 0 && matchesAnyDomain(hostname, blocked)) {
    return false;
  }
  const allowed = normalizeDomainList(filter.allowedDomains);
  if (allowed.length > 0 && !matchesAnyDomain(hostname, allowed)) {
    return false;
  }
  return true;
};

// Literal case-insensitive substring matcher with context windows;
// mirrors gpt-oss `find` rendering minus the cursor-numbered output.
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py

interface FindMatch {
  before: string;
  matched: string;
  after: string;
}

export const findMatches = (
  text: string,
  pattern: string,
  opts: { maxMatches: number; contextChars: number },
): FindMatch[] => {
  if (pattern.length === 0) return [];
  const lowerText = text.toLowerCase();
  const lowerPat = pattern.toLowerCase();
  const matches: FindMatch[] = [];
  let from = 0;
  while (matches.length < opts.maxMatches) {
    const idx = lowerText.indexOf(lowerPat, from);
    if (idx < 0) break;
    const beforeStart = Math.max(0, idx - opts.contextChars);
    const afterEnd = Math.min(text.length, idx + lowerPat.length + opts.contextChars);
    matches.push({
      before: text.slice(beforeStart, idx),
      matched: text.slice(idx, idx + lowerPat.length),
      after: text.slice(idx + lowerPat.length, afterEnd),
    });
    from = idx + lowerPat.length;
  }
  return matches;
};

export const formatMatches = (pattern: string, url: string, matches: readonly FindMatch[]): string => {
  if (matches.length === 0) return findNoMatchesText(pattern, url);
  const noun = matches.length === 1 ? 'match' : 'matches';
  const lines: string[] = [`${matches.length} ${noun} for pattern: \`${pattern}\``, ''];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    lines.push(`Match ${i + 1}:`);
    lines.push(`"...${m.before}[${m.matched}]${m.after}..."`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
};

const truncateString = (s: string, maxChars: number): string =>
  s.length <= maxChars ? s : `${truncatePreservingCodePoints(s, maxChars)}…`;

const errorSnippet = (title: string, snippet: string): ResponseWebSearchResult => ({
  type: 'text_result',
  url: '',
  title,
  snippet,
});

// Resolve the configured backend or return an `unavailable` reason.
// Disabled / missing-credential is per-op visible: each backend
// dispatch synthesizes a snippet IR so the model sees the error
// in-band instead of the whole request 5xx'ing.
const resolveActiveProvider = async (
  state: ShimState,
): Promise<{ provider: WebSearchProvider; providerName: WebSearchProviderName } | { unavailable: string }> => {
  const configured = await state.getProvider();
  if (configured.type === 'enabled') {
    return { provider: configured.impl, providerName: configured.provider };
  }
  if (configured.type === 'disabled') {
    return { unavailable: 'Web search provider is not configured on this gateway.' };
  }
  return { unavailable: `Web search provider ${configured.provider} is missing its credential on this gateway.` };
};

const runBackendSearch = async (
  id: string,
  op: Extract<ShimLogicalOperation, { kind: 'search' }>,
  state: ShimState,
): Promise<WebSearchCallIR> => {
  const query = op.query;

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(id, query, [errorSnippet(title, op.error)]);
  }

  const active = await resolveActiveProvider(state);
  if ('unavailable' in active) {
    return searchIr(id, query, [errorSnippet('Search error', searchFailedText(active.unavailable))]);
  }

  try {
    const searchRequest = {
      query,
      maxResults: state.filters.maxResults,
      allowedDomains: state.filters.allowedDomains,
      blockedDomains: state.filters.blockedDomains,
      userLocation: state.filters.userLocation,
      ...(state.downstreamAbortSignal !== undefined ? { signal: state.downstreamAbortSignal } : {}),
    };
    const result = state.apiKeyId !== undefined
      ? await searchWebAndRecordUsage({
          provider: active.provider,
          providerName: active.providerName,
          keyId: state.apiKeyId,
          request: searchRequest,
        })
      : await searchWebWithoutRecordingUsage({
          provider: active.provider,
          request: searchRequest,
        });

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode;
      return searchIr(id, query, [errorSnippet('Search error', searchFailedText(msg))]);
    }

    // Per-snippet char cap on web_search_call.results[].snippet. Providers
    // like Tavily can return multi-KB snippets per hit; without this cap a
    // single noisy query can blow the upstream context window. Independent
    // of the provider-enforced 10 KiB cap on open_page bodies.
    const results: ResponseWebSearchResult[] = result.results.map(r => ({
      type: 'text_result' as const,
      url: r.source,
      title: r.title,
      snippet: truncateString(r.content.map(c => c.text).join('\n'), 2_048),
    }));
    // Native gates `action.sources` on `include:
    // ["web_search_call.action.sources"]`; build the list only when
    // the client opted in. The shape mirrors openai-python
    // `ActionSearch.sources[]` (`{type:'url', url}`).
    const sources = state.includeSearchActionSources
      ? result.results.map(r => ({ type: 'url' as const, url: r.source }))
      : undefined;
    return searchIr(id, query, results, sources);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return searchIr(id, query, [errorSnippet('Search error', searchFailedText(msg))]);
  }
};

const runBatchFetch = async (
  needFetch: string[],
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  const perUrl = new Map<string, FetchAndCacheResult>();
  const active = await resolveActiveProvider(state);
  if ('unavailable' in active) {
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, active.unavailable) });
    }
    return perUrl;
  }
  try {
    const fetchRequest = {
      urls: needFetch,
      ...(state.downstreamAbortSignal !== undefined ? { signal: state.downstreamAbortSignal } : {}),
    };
    const result = state.apiKeyId !== undefined
      ? await fetchPageAndRecordUsage({
          provider: active.provider,
          providerName: active.providerName,
          keyId: state.apiKeyId,
          request: fetchRequest,
        })
      : await fetchPageWithoutRecordingUsage({
          provider: active.provider,
          request: fetchRequest,
        });

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode;
      for (const url of needFetch) {
        perUrl.set(url, { ok: false, output: openFailedText(url, msg) });
      }
      return perUrl;
    }

    const failureByUrl = new Map(result.failures.map(f => [f.url, f]));
    const pageByUrl = new Map(result.pages.map(p => [p.url, p]));
    for (const url of needFetch) {
      const failure = failureByUrl.get(url);
      if (failure) {
        perUrl.set(url, { ok: false, output: openFailedText(url, failure.message ?? failure.errorCode) });
        continue;
      }
      const page = pageByUrl.get(url);
      if (!page) {
        // URL silently dropped by the provider — surface as explicit
        // error so the model doesn't see a phantom empty page.
        perUrl.set(url, { ok: false, output: openFailedText(url, 'No page returned') });
        continue;
      }
      const entry: PageCacheEntry = {
        content: page.content,
        truncated: page.truncated,
        fullContentBytes: page.fullContentBytes,
        title: page.title,
      };
      state.pageCache.set(url, entry);
      perUrl.set(url, { ok: true, cached: entry });
    }
    return perUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, msg) });
    }
    return perUrl;
  }
};

// Intra-umbrella batching: collect every URL the umbrella's
// open[]/find[] sub-arrays reference, dedup, hit cache, and issue
// one batched provider.fetchPage for the remainder. Cross-umbrella
// joining is deliberately NOT done — same-turn serial execution
// means later umbrellas can simply read the populated cache.
const fetchAndCacheManyPages = async (
  urls: string[],
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  const results = new Map<string, FetchAndCacheResult>();
  const needFetch: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const cached = state.pageCache.get(url);
    if (cached) {
      results.set(url, { ok: true, cached });
      continue;
    }
    needFetch.push(url);
  }

  if (needFetch.length > 0) {
    const perUrl = await runBatchFetch(needFetch, state);
    for (const url of needFetch) {
      results.set(url, perUrl.get(url)!);
    }
  }
  return results;
};

const openPageSuccessIr = (id: string, url: string, cached: PageCacheEntry): WebSearchCallIR => {
  // Provider truncates to its 10 KiB per-page cap. Truncated bodies get
  // a sentinel so the model can choose to `find` for specific content.
  const body = cached.content
    + (cached.truncated ? `\n\n${truncationSentinel(cached.fullContentBytes)}` : '');
  return openPageIr(id, url, [{
    type: 'text_result',
    url,
    title: cached.title ?? '',
    snippet: body,
  }]);
};

const runBackendOpenPage = async (
  id: string,
  op: Extract<ShimLogicalOperation, { kind: 'open' }>,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  const url = op.url;

  // Invalid-ref-id (`op.error !== undefined`) carries a
  // `{type:'search', queries:[ref_id]}` via `searchIr` because a urlless
  // open_page action would be meaningless.
  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(id, op.url, [errorSnippet(title, op.error)]);
  }

  // Batch fetch pre-populates entries for every URL the parser produced
  // (blocked URLs get an explicit failure entry), so the lookup is total.
  const fetched = (await batchPromise).get(url)!;
  if (!fetched.ok) {
    return openPageIr(id, url, [errorSnippet('Open page error', fetched.output)]);
  }
  return openPageSuccessIr(id, url, fetched.cached);
};

const runBackendFind = async (
  id: string,
  op: Extract<ShimLogicalOperation, { kind: 'find' }>,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  const url = op.url;
  const pattern = op.pattern;

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return findInPageIr(id, url, pattern, [errorSnippet(title, op.error)]);
  }

  // Pre-fetch failures keep the `find_in_page` action carrying the
  // original url + pattern; switching to `open_page` would silently
  // change `action.type` mid-result.
  const fetched = (await batchPromise).get(url)!;
  if (!fetched.ok) {
    return findInPageIr(id, url, pattern, [errorSnippet('Find error', fetched.output)]);
  }

  // Mirror gpt-oss `find` defaults.
  const matches = findMatches(fetched.cached.content, pattern, {
    maxMatches: 10,
    contextChars: 200,
  });
  // Native find_in_page returns one result whose snippet either lists
  // the matches or says "No matching ...".
  const title = matches.length === 0 ? 'No match' : 'Matches';
  return findInPageIr(id, url, pattern, [{
    type: 'text_result',
    url,
    title,
    snippet: formatMatches(pattern, url, matches),
  }]);
};

const executeOperation = (
  id: string,
  op: ShimLogicalOperation,
  state: ShimState,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  switch (op.kind) {
  case 'search':
    return runBackendSearch(id, op, state);
  case 'open':
    return runBackendOpenPage(id, op, batchPromise);
  case 'find':
    return runBackendFind(id, op, batchPromise);
  case 'unsupported':
    return Promise.resolve(schemaErrorIr(
      id,
      `unsupported action: ${op.subProperty}[${op.arrayIndex}]`,
      'Unsupported action',
      unsupportedSubPropertyText(op.subProperty),
    ));
  case 'wrong-type':
    return Promise.resolve(schemaErrorIr(
      id,
      `wrong-type sub-property: ${op.subProperty}`,
      'Malformed sub-property',
      wrongTypeSubPropertyText(op.subProperty, op.actualType),
    ));
  }
};

// Per-umbrella bypass: each parsed op resolves to a snippet IR
// carrying `snippetText` in the action shape closest to what the
// model asked for. Used for both the iteration-cap exhaustion and
// the `max_tool_calls` budget exhaustion.
//   https://github.com/tinfoilsh/confidential-model-router/blob/4ad5a7229fdd37f5d270b56a92dfb23a3fb2b562/toolruntime/chat_stream.go#L1014-L1019
const irForBypassedOp = (id: string, op: ShimLogicalOperation, snippetText: string): WebSearchCallIR => {
  switch (op.kind) {
  case 'search':
    return searchIr(id, op.query, [errorSnippet('Search error', snippetText)]);
  case 'open':
    if (op.error !== undefined) {
      return searchIr(id, op.url, [errorSnippet('Open page error', snippetText)]);
    }
    return openPageIr(id, op.url, [errorSnippet('Open page error', snippetText)]);
  case 'find':
    return findInPageIr(id, op.url, op.pattern, [errorSnippet('Find error', snippetText)]);
  case 'unsupported':
    return schemaErrorIr(
      id,
      `unsupported action: ${op.subProperty}[${op.arrayIndex}]`,
      'Unsupported action',
      snippetText,
    );
  case 'wrong-type':
    return schemaErrorIr(
      id,
      `wrong-type sub-property: ${op.subProperty}`,
      'Malformed sub-property',
      snippetText,
    );
  }
};

// Collect the open/find URL set for THIS umbrella and kick off one
// provider.fetchPage covering all of them. `fetchAndCacheManyPages`
// installs per-URL inflight slots synchronously so later umbrellas in
// the same turn dedup against this batch.
//
// Blocked URLs (failing `isUrlAllowed`) are filtered OUT of the batch
// fetch but populated into the result map with an explicit
// `{ ok: false, output: 'Error fetching URL <url>: Blocked by tool
// filters' }` entry (the `Blocked by tool filters` string runs
// through `openFailedText` for consistency with real fetch failures).
// That way the per-op handlers (`runBackendOpenPage` /
// `runBackendFind`) can trust the gate's verdict by reading the map
// directly instead of re-running `isUrlAllowed` themselves.
const BLOCKED_BY_FILTER_OUTPUT = 'Blocked by tool filters';

const startBatchFetchForUmbrella = async (
  parsed: ParsedUmbrella,
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  if (parsed.kind !== 'ops') return new Map();
  const batchUrls: string[] = [];
  const blockedUrls: string[] = [];
  const seen = new Set<string>();
  for (const op of parsed.ops) {
    if (op.kind !== 'open' && op.kind !== 'find') continue;
    if (op.error !== undefined) continue;
    const url = op.url;
    if (url === '') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isUrlAllowed(url, state.filters)) {
      blockedUrls.push(url);
      continue;
    }
    batchUrls.push(url);
  }
  const fetched = await fetchAndCacheManyPages(batchUrls, state);
  for (const url of blockedUrls) {
    fetched.set(url, { ok: false, output: openFailedText(url, BLOCKED_BY_FILTER_OUTPUT) });
  }
  return fetched;
};

const planBypassedSlots = (
  parsed: ParsedUmbrella,
  snippetText: string,
): { id: string; promise: Promise<WebSearchCallIR> }[] => {
  if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
    const id = synthesizeWebSearchCallId();
    return [{
      id,
      promise: Promise.resolve(schemaErrorIr(id, 'malformed umbrella arguments', 'Tool call budget exhausted', snippetText)),
    }];
  }
  return parsed.ops.map(op => {
    const id = synthesizeWebSearchCallId();
    return { id, promise: Promise.resolve(irForBypassedOp(id, op, snippetText)) };
  });
};

const planUmbrellaSlots = (
  parsed: ParsedUmbrella,
  state: ShimState,
): { id: string; promise: Promise<WebSearchCallIR> }[] => {
  // Gateway-side cap takes precedence over the client-supplied budget.
  if (state.iterationCount > ITERATION_CAP) {
    return planBypassedSlots(parsed, iterationCapText);
  }
  if (state.remainingToolCalls !== undefined && state.remainingToolCalls <= 0) {
    return planBypassedSlots(parsed, budgetExhaustedText);
  }

  if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
    const id = synthesizeWebSearchCallId();
    return [{
      id,
      promise: Promise.resolve(schemaErrorIr(id, 'malformed umbrella arguments', 'Malformed arguments', emptyUmbrellaArgsText)),
    }];
  }

  const batchPromise = startBatchFetchForUmbrella(parsed, state);

  return parsed.ops.map(op => {
    const id = synthesizeWebSearchCallId();
    return { id, promise: executeOperation(id, op, state, batchPromise) };
  });
};

export const createUmbrellaDispatcher = (
  state: ShimState,
  merge: MergeState,
) => {
  return (intercepted: InterceptedFunctionCall): {
    slots: UmbrellaSlot<WebSearchCallIR>[];
    startFrames: ProtocolFrame<ResponsesStreamEvent>[];
  } => {
    const parsed = parseUmbrellaOperations(intercepted.argumentsJson);

    const planned = planUmbrellaSlots(parsed, state);
    // Decrement the budget AFTER planning. `planUmbrellaSlots`
    // reads the pre-decrement value, so the umbrella that takes
    // the counter from 1 to 0 still gets its backend dispatch;
    // the next umbrella reads 0 and bypasses.
    if (state.remainingToolCalls !== undefined) {
      state.remainingToolCalls -= 1;
    }

    const slots: UmbrellaSlot<WebSearchCallIR>[] = [];
    const startFrames: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for (let i = 0; i < planned.length; i++) {
      const { id, promise } = planned[i];
      // Slot 0 inherits reservedDownstreamIndex; the rest allocate fresh.
      const { outputIndex, frames } = emitWebSearchCallLifecycleStart(merge, {
        synthesizedId: id,
        ...(i === 0 ? { reservedOutputIndex: intercepted.reservedDownstreamIndex } : {}),
      });
      slots.push({ synthesizedId: id, outputIndex, irPromise: promise });
      startFrames.push(...frames);
    }
    return { slots, startFrames };
  };
};
