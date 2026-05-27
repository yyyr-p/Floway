import { test } from 'vitest';

import {
  emitWebSearchCallLifecycleEnd,
  emitWebSearchCallLifecycleStart,
  findInPageIr,
  findNoMatchesText,
  inputItemToIr,
  irToOutputText,
  irToUpstreamPair,
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
import { createMergeState } from './merge-state.ts';
import { assert, assertEquals, assertFalse } from '../../../../../../test-assert.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  ResponseOutputWebSearchCall,
  ResponsesStreamEvent,
  ResponseWebSearchAction,
  ResponseWebSearchResult,
} from '@floway-dev/protocols/responses';

const FIXED_ID = 'ws_test_fixed_0123456789abcdef';

const fixedIr = (overrides: Partial<WebSearchCallIR> = {}): WebSearchCallIR => ({
  id: FIXED_ID,
  status: 'completed',
  action: { type: 'search', queries: ['hello'] },
  results: [{ type: 'text_result', url: 'https://x', title: 'X', snippet: 'snip' }],
  ...overrides,
});

test('synthesizeWebSearchCallId produces unique ws_gw_ prefixed ids', () => {
  const a = synthesizeWebSearchCallId();
  const b = synthesizeWebSearchCallId();
  assert(a.startsWith('ws_gw_'));
  assert(b.startsWith('ws_gw_'));
  assert(a !== b);
});

test('searchIr places query in action.queries and uses status=completed', () => {
  const ir = searchIr(FIXED_ID, 'hello world', []);
  assertEquals(ir.status, 'completed');
  assertEquals(ir.id, FIXED_ID);
  // Both `query` (singular, required by openai-python ActionSearch)
  // and `queries` (plural, newer codex) are populated so every typed
  // SDK reads the value regardless of which field its model declares.
  assertEquals(ir.action, { type: 'search', query: 'hello world', queries: ['hello world'] });
  assertEquals(ir.results, []);
});

test('openPageIr with url preserves it on the action', () => {
  const ir = openPageIr(FIXED_ID, 'https://example.com', []);
  assertEquals(ir.action, { type: 'open_page', url: 'https://example.com' });
});

test('openPageIr with undefined url omits the field from the action (matches native soft-failure shape)', () => {
  const ir = openPageIr(FIXED_ID, undefined, [{ type: 'text_result', url: '', title: 'Error', snippet: 'fetch failed' }]);
  assertEquals(ir.action, { type: 'open_page' });
  assertEquals(ir.results.length, 1);
});

test('findInPageIr keeps url and pattern on the action', () => {
  const ir = findInPageIr(FIXED_ID, 'https://x', 'p', []);
  assertEquals(ir.action, { type: 'find_in_page', url: 'https://x', pattern: 'p' });
});

test('schemaErrorIr uses action.type=search with descriptive queries entry', () => {
  const ir = schemaErrorIr(FIXED_ID, 'unsupported action: click[0]', 'Unsupported action', 'Error: this gateway does not support `click`.');
  // Both `query` and `queries` set so openai-python-style SDKs reading
  // the singular `query` field don't see undefined for the diagnostic.
  assertEquals(ir.action, { type: 'search', query: 'unsupported action: click[0]', queries: ['unsupported action: click[0]'] });
  assertEquals(ir.results.length, 1);
  assertEquals(ir.results[0].snippet, 'Error: this gateway does not support `click`.');
  assertEquals(ir.results[0].title, 'Unsupported action');
});

test('schemaErrorIr accepts a custom title (Case 5 malformed args uses "Malformed arguments")', () => {
  const ir = schemaErrorIr(FIXED_ID, 'malformed umbrella arguments', 'Malformed arguments', 'Error: arguments must be a JSON object.');
  assertEquals(ir.results[0].title, 'Malformed arguments');
  assertEquals(ir.results[0].snippet, 'Error: arguments must be a JSON object.');
});

test('inputItemToIr passes through a well-formed input item verbatim', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_input_abc',
    status: 'completed',
    action: { type: 'open_page', url: 'https://y' },
    results: [{ type: 'text_result', url: 'https://y', title: 'Y', snippet: 'body' }],
  });
  assert(ir !== null);
  assertEquals(ir.id, 'ws_input_abc');
  assertEquals(ir.action, { type: 'open_page', url: 'https://y' });
  assertEquals(ir.results.length, 1);
});

test('inputItemToIr returns null for items lacking an action (no neutral fabrication)', () => {
  const ir = inputItemToIr({ type: 'web_search_call' });
  assertEquals(ir, null);
});

test('inputItemToIr synthesizes a fresh id when the echoed item dropped it (clients like codex CLI strip ws_gw_ ids on session persist)', () => {
  const irMissing = inputItemToIr({
    type: 'web_search_call',
    action: { type: 'search', queries: ['q'] },
  });
  assert(irMissing !== null);
  assertEquals(irMissing.id.startsWith('ws_gw_'), true);
  const irEmpty = inputItemToIr({
    type: 'web_search_call',
    id: '',
    action: { type: 'search', queries: ['q'] },
  });
  assert(irEmpty !== null);
  assertEquals(irEmpty.id.startsWith('ws_gw_'), true);
});

test('inputItemToIr marks resultsStripped when the echoed item has no results field', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_kept',
    action: { type: 'search', queries: ['q'] },
  });
  assert(ir !== null);
  assertEquals(ir.resultsStripped, true);
  assertEquals(ir.results, []);
});

test('inputItemToIr leaves resultsStripped unset when results is an empty array (zero-hit search, not stripped)', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_kept',
    action: { type: 'search', queries: ['q'] },
    results: [],
  });
  assert(ir !== null);
  assertEquals(ir.resultsStripped, undefined);
});

test('inputItemToIr clamps status to completed regardless of source value', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_abc',
    status: 'failed',
    action: { type: 'search', queries: ['q'] },
  });
  assert(ir !== null);
  assertEquals(ir.status, 'completed');
});

test('irToUpstreamPair derives a stable call_id from the IR id and shares it on both items', () => {
  const ir = fixedIr({ id: 'ws_x' });
  const pair = irToUpstreamPair(ir, 'web_search');
  assertEquals(pair.functionCall.call_id, pair.functionCallOutput.call_id);
  assertEquals(pair.functionCall.call_id, 'cc_from_ws_x');
  assertEquals(pair.functionCall.name, 'web_search');
  assertEquals(pair.functionCall.arguments, JSON.stringify({ search_query: [{ q: 'hello' }] }));
});

test('irToUpstreamPair uses the umbrella tool name passed in (collision-fallback aware)', () => {
  const ir = fixedIr();
  const pair = irToUpstreamPair(ir, 'web_search_2');
  assertEquals(pair.functionCall.name, 'web_search_2');
});

test('irToOutputText for search action uses formatSearchResults shape (Search results for X then numbered hits)', () => {
  const ir = searchIr(FIXED_ID, 'hello', [{ type: 'text_result', url: 'https://x', title: 'X', snippet: 'body' }]);
  const text = irToOutputText(ir);
  assert(text.startsWith('Search results for "hello":'));
  assert(text.includes('[1] X'));
  assert(text.includes('https://x'));
  assert(text.includes('body'));
});

test('irToOutputText for open_page action uses the result snippet (page body) as the text', () => {
  const ir = openPageIr(FIXED_ID, 'https://y', [{ type: 'text_result', url: 'https://y', title: 'Y', snippet: 'page body here' }]);
  const text = irToOutputText(ir);
  assertEquals(text, 'page body here');
});

test('irToOutputText for find_in_page action uses the result snippet (formatMatches output) verbatim', () => {
  const ir = findInPageIr(FIXED_ID, 'https://x', 'needle', [{ type: 'text_result', url: '', title: 'No match', snippet: 'No matching `needle` found on https://x.' }]);
  const text = irToOutputText(ir);
  assertEquals(text, 'No matching `needle` found on https://x.');
});

test('irToOutputText for an open_page failure (no results) emits a "(no body returned)" sentinel', () => {
  const ir = openPageIr(FIXED_ID, undefined, []);
  const text = irToOutputText(ir);
  assertEquals(text, 'Open (no url): (no body returned)');
});

test('searchFailedText formats provider message', () => {
  assertEquals(searchFailedText('rate limited'), 'Search failed: rate limited');
});

test('openFailedText formats URL and provider message', () => {
  assertEquals(openFailedText('https://x.com', '404'), 'Error fetching URL `https://x.com`: 404');
});

test('openFailedText handles the blocked-by-filter sentinel uniformly', () => {
  assertEquals(
    openFailedText('https://x.com', 'Blocked by tool filters'),
    'Error fetching URL `https://x.com`: Blocked by tool filters',
  );
});

test('findNoMatchesText includes URL and uses "No matching ..." wording (mirrors native find_in_page no-match snippet)', () => {
  assertEquals(findNoMatchesText('foo bar', 'https://x.com'), 'No matching `foo bar` found on https://x.com.');
});

test('iterationCapText is the exact text fed back to the model on cap-exceeded turns', () => {
  assertEquals(
    iterationCapText,
    'Web search iteration limit (30) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you\'ve gathered.',
  );
});

test('truncationSentinel formats full-page byte count', () => {
  assertEquals(
    truncationSentinel(50_000),
    '[Content truncated; full page is 50000 bytes. Use web_search\'s `find` sub-property with a pattern to locate specific content.]',
  );
});

test('truncationSentinel handles zero bytes', () => {
  assertEquals(
    truncationSentinel(0),
    '[Content truncated; full page is 0 bytes. Use web_search\'s `find` sub-property with a pattern to locate specific content.]',
  );
});

// ── truncatePreservingCodePoints boundary cases ───────────────────────

test('truncatePreservingCodePoints: empty string is a no-op', () => {
  assertEquals(truncatePreservingCodePoints('', 512), '');
});

test('truncatePreservingCodePoints: string of exactly `max` length is unchanged (no ellipsis injected)', () => {
  const s = 'a'.repeat(512);
  assertEquals(truncatePreservingCodePoints(s, 512), s);
});

test('truncatePreservingCodePoints: high surrogate at position max-1 walks back to drop the orphan', () => {
  // U+1F600 (grinning face) is a surrogate pair: high D83D + low DE00.
  // Place the high surrogate at index max-1 (= 9) so a naive
  // slice(0, max) would retain the orphan high surrogate. The helper
  // must walk back one code unit and slice at max-1 (= 9), producing
  // a 9-char string with no orphan.
  const prefix = 'a'.repeat(9); // chars 0..8
  const emoji = '😀'; // chars 9..10 → high at 9, low at 10
  const suffix = 'b';
  const input = prefix + emoji + suffix; // length 12
  const out = truncatePreservingCodePoints(input, 10);
  assertEquals(out.length, 9);
  assertEquals(out, prefix);
  // Sanity: no orphan high surrogate in the output.
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);
    assertFalse(code >= 0xD800 && code <= 0xDBFF);
  }
});

// Search-result text rendering is exercised through `irToOutputText`
// because the formatter is a private helper inside ir.ts. These tests
// verify the wire shape clients depend on.

test('irToOutputText (search) empty results renders header + (no results)', () => {
  assertEquals(
    irToOutputText(searchIr(FIXED_ID, 'deepseek', [])),
    'Search results for "deepseek":\n\n(no results)',
  );
});

test('irToOutputText (search) single result rendered with index 1', () => {
  const out = irToOutputText(searchIr(FIXED_ID, 'deepseek', [
    { type: 'text_result', url: 'https://deepseek.ai', title: 'DeepSeek', snippet: 'AI company.' },
  ]));
  assertEquals(
    out,
    'Search results for "deepseek":\n\n[1] DeepSeek\nhttps://deepseek.ai\nAI company.',
  );
});

test('irToOutputText (search) three results separated by blank lines', () => {
  const out = irToOutputText(searchIr(FIXED_ID, 'llms', [
    { type: 'text_result', url: 'https://a.com', title: 'A', snippet: 'sa' },
    { type: 'text_result', url: 'https://b.com', title: 'B', snippet: 'sb' },
    { type: 'text_result', url: 'https://c.com', title: 'C', snippet: 'sc' },
  ]));
  assertEquals(
    out,
    'Search results for "llms":\n\n[1] A\nhttps://a.com\nsa\n\n[2] B\nhttps://b.com\nsb\n\n[3] C\nhttps://c.com\nsc',
  );
});

test('irToOutputText (search) query is interpolated verbatim into the header', () => {
  const out = irToOutputText(searchIr(FIXED_ID, 'quotes "inside" the query', []));
  assertEquals(out.startsWith('Search results for "quotes "inside" the query":'), true);
});

// emitWebSearchCallLifecycle{Start,End} drive the synthesized
// web_search_call wire frames; tests verify ordering, indexing, and
// the merge-state side effects.

const eventOf = (frame: ProtocolFrame<ResponsesStreamEvent>): ResponsesStreamEvent => {
  assert(frame.type === 'event');
  return frame.event;
};

const fullLifecycle = (
  state: ReturnType<typeof createMergeState>,
  args: {
    synthesizedId: string;
    action: ResponseWebSearchAction;
    results: ResponseWebSearchResult[];
  },
): ProtocolFrame<ResponsesStreamEvent>[] => {
  const start = emitWebSearchCallLifecycleStart(state, {
    synthesizedId: args.synthesizedId,
  });
  const end = emitWebSearchCallLifecycleEnd(state, {
    synthesizedId: args.synthesizedId,
    outputIndex: start.outputIndex,
    action: args.action,
    results: args.results,
  });
  return [...start.frames, ...end];
};

test('lifecycle: emits the five-event sequence in order', () => {
  const state = createMergeState();
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_gw_1',
    action: { type: 'search', queries: ['hello'] },
    results: [],
  });
  assertEquals(frames.map(f => eventOf(f).type), [
    'response.output_item.added',
    'response.web_search_call.in_progress',
    'response.web_search_call.searching',
    'response.web_search_call.completed',
    'response.output_item.done',
  ]);
});

test('lifecycle: start half emits added → in_progress → searching only', () => {
  const state = createMergeState();
  const { frames } = emitWebSearchCallLifecycleStart(state, {
    synthesizedId: 'ws_x',
  });
  assertEquals(frames.map(f => eventOf(f).type), [
    'response.output_item.added',
    'response.web_search_call.in_progress',
    'response.web_search_call.searching',
  ]);
});

test('lifecycle: end half emits completed → done only', () => {
  const state = createMergeState();
  const start = emitWebSearchCallLifecycleStart(state, {
    synthesizedId: 'ws_x',
  });
  const end = emitWebSearchCallLifecycleEnd(state, {
    synthesizedId: 'ws_x',
    outputIndex: start.outputIndex,
    action: { type: 'search', queries: ['q'] },
    results: [],
  });
  assertEquals(end.map(f => eventOf(f).type), [
    'response.web_search_call.completed',
    'response.output_item.done',
  ]);
});

test('lifecycle: all five events share the same output_index', () => {
  const state = createMergeState();
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_gw_1',
    action: { type: 'search', queries: ['q'] },
    results: [],
  });
  const idxes = frames.map(f => (eventOf(f) as { output_index: number }).output_index);
  assertEquals(new Set(idxes).size, 1);
  assertEquals(idxes[0], 0);
});

test('lifecycle: start half advances state.outputIndex by exactly one', () => {
  const state = createMergeState();
  state.outputIndex = 7;
  const { outputIndex } = emitWebSearchCallLifecycleStart(state, {
    synthesizedId: 'ws_gw_1',
  });
  assertEquals(outputIndex, 7);
  assertEquals(state.outputIndex, 8);
});

test('lifecycle: sequence numbers increment monotonically across the five events', () => {
  const state = createMergeState();
  state.sequenceNumber = 5;
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_gw_1',
    action: { type: 'open_page', url: 'https://x.com' },
    results: [],
  });
  assertEquals(
    frames.map(f => (eventOf(f) as { sequence_number?: number }).sequence_number),
    [5, 6, 7, 8, 9],
  );
  assertEquals(state.sequenceNumber, 10);
});

test('lifecycle: in-flight item has status:"in_progress" with NO action (matches native)', () => {
  // Native upstreams omit `action` on the `.added` half and populate
  // it only on `.done`; the shim follows suit. Clients that render
  // action.* read from the done frame.
  const state = createMergeState();
  const { frames } = emitWebSearchCallLifecycleStart(state, { synthesizedId: 'ws_x' });
  const added = eventOf(frames[0]) as Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;
  assert(added.item.type === 'web_search_call');
  const item = added.item as ResponseOutputWebSearchCall;
  assertEquals(item.status, 'in_progress');
  assertEquals(item.id, 'ws_x');
  assertFalse('action' in item);
  // No `results` on the in-flight item — backend hasn't resolved yet.
  assertEquals(Object.keys(item).sort(), ['id', 'status', 'type']);
});

test('lifecycle: terminal output_item.done has status:"completed" with same id and action', () => {
  const state = createMergeState();
  const action: ResponseWebSearchAction = { type: 'find_in_page', url: 'https://x.com', pattern: 'foo' };
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_x',
    action,
    results: [],
  });
  const done = eventOf(frames[4]) as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;
  assert(done.item.type === 'web_search_call');
  const item = done.item as ResponseOutputWebSearchCall;
  assertEquals(item.status, 'completed');
  assertEquals(item.action, action);
  assertEquals(item.id, 'ws_x');
});

test('lifecycle: in_progress / completed events carry item_id = synthesizedId', () => {
  const state = createMergeState();
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_xyz',
    action: { type: 'search', queries: ['q'] },
    results: [],
  });
  const inProgress = eventOf(frames[1]) as Extract<ResponsesStreamEvent, { type: 'response.web_search_call.in_progress' }>;
  const completed = eventOf(frames[3]) as Extract<ResponsesStreamEvent, { type: 'response.web_search_call.completed' }>;
  assertEquals(inProgress.item_id, 'ws_xyz');
  assertEquals(completed.item_id, 'ws_xyz');
});

test('lifecycle: results are ALWAYS populated on the terminal item (always-include divergence)', () => {
  const state = createMergeState();
  const results: ResponseWebSearchResult[] = [
    { type: 'text_result', url: 'https://x.com', title: 'T', snippet: 's' },
  ];
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_x',
    action: { type: 'search', queries: ['q'] },
    results,
  });
  const done = eventOf(frames[4]) as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;
  const item = done.item as ResponseOutputWebSearchCall;
  assertEquals(item.results, results);
});

test('lifecycle: empty results array still surfaces on the terminal item (not omitted)', () => {
  const state = createMergeState();
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_x',
    action: { type: 'search', queries: ['q'] },
    results: [],
  });
  const done = eventOf(frames[4]) as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;
  const item = done.item as ResponseOutputWebSearchCall;
  assertEquals(item.results, []);
});

test('lifecycle: end half records the completed item into state.accumulatedOutput', () => {
  const state = createMergeState();
  fullLifecycle(state, {
    synthesizedId: 'ws_x',
    action: { type: 'search', queries: ['q'] },
    results: [],
  });
  assertEquals(state.accumulatedOutput.size, 1);
  const item = state.accumulatedOutput.get(0) as ResponseOutputWebSearchCall;
  assertEquals(item.type, 'web_search_call');
  assertEquals(item.id, 'ws_x');
  assertEquals(item.status, 'completed');
});

test('lifecycle: open_page action shape', () => {
  const state = createMergeState();
  const frames = fullLifecycle(state, {
    synthesizedId: 'ws_o',
    action: { type: 'open_page', url: 'https://example.com/page' },
    results: [],
  });
  const done = eventOf(frames[4]) as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;
  const item = done.item as ResponseOutputWebSearchCall;
  assertEquals(item.action, { type: 'open_page', url: 'https://example.com/page' });
});
