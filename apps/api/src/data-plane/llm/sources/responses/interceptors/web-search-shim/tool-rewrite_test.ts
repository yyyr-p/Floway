import { test } from 'vitest';

import {
  isHostedWebSearchTool,
  type PreparedTools,
  prepareToolsForShim,
  resolveShimToolName,
  SHIM_TOOL_NAME,
  WEB_SEARCH_HOSTED_TYPES,
} from './tool-rewrite.ts';
import { assert, assertEquals } from '../../../../../../test-assert.ts';
import type { ResponseTool, ResponseToolChoice } from '@floway-dev/protocols/responses';

// Thin wrapper for tests that exercise the success path. The
// underlying `prepareToolsForShim` returns a Result discriminator to
// surface validation errors as 400s; tests asserting validation
// failures call it directly.
const rewriteToolsForShim = (
  tools: ResponseTool[],
  toolChoice: ResponseToolChoice | undefined,
): PreparedTools => {
  const result = prepareToolsForShim(tools, toolChoice);
  assert(result.ok);
  return result.prepared;
};

const HOSTED_VARIANTS = [
  'web_search',
  'web_search_2025_08_26',
  'web_search_preview',
  'web_search_preview_2025_03_11',
] as const;

const UMBRELLA = SHIM_TOOL_NAME;

test('WEB_SEARCH_HOSTED_TYPES covers all four aliases', () => {
  for (const t of HOSTED_VARIANTS) {
    assertEquals(WEB_SEARCH_HOSTED_TYPES.has(t), true);
  }
});

test('isHostedWebSearchTool recognizes each hosted variant', () => {
  for (const t of HOSTED_VARIANTS) {
    assertEquals(isHostedWebSearchTool({ type: t } as ResponseTool), true);
  }
});

test('isHostedWebSearchTool returns false for function / custom tools', () => {
  assertEquals(
    isHostedWebSearchTool({ type: 'function', name: 'x', parameters: {}, strict: false }),
    false,
  );
  assertEquals(isHostedWebSearchTool({ type: 'custom', name: 'x' }), false);
});

for (const variant of HOSTED_VARIANTS) {
  test(`rewriteToolsForShim: ${variant} expands to one umbrella function tool`, () => {
    const { tools, filters, shimToolName } = rewriteToolsForShim([{ type: variant } as ResponseTool], undefined);
    assertEquals(tools.length, 1);
    assertEquals((tools[0] as { type: string }).type, 'function');
    assertEquals((tools[0] as { name: string }).name, UMBRELLA);
    assertEquals(shimToolName, UMBRELLA);
    // Bare-hosted entry (no filters / location / context size) still
    // gets `maxResults: 20` because the omitted `search_context_size`
    // defaults to `'medium'` to match native's documented default.
    assertEquals(filters, { maxResults: 20 });
  });
}

test('rewriteToolsForShim: umbrella tool declares search_query / open / find sub-properties', () => {
  const { tools } = rewriteToolsForShim([{ type: 'web_search' } as ResponseTool], undefined);
  const umbrella = tools[0] as unknown as { name: string; parameters: { properties: Record<string, unknown> } };
  assertEquals(umbrella.name, UMBRELLA);
  const props = umbrella.parameters.properties;
  assertEquals(Object.keys(props).sort(), ['find', 'open', 'search_query']);
});

test('rewriteToolsForShim: umbrella tool sub-properties are arrays of objects', () => {
  const { tools } = rewriteToolsForShim([{ type: 'web_search' } as ResponseTool], undefined);
  const props = (tools[0] as unknown as { parameters: { properties: Record<string, { type: string; items: { type: string } }> } }).parameters.properties;
  for (const key of ['search_query', 'open', 'find']) {
    assertEquals(props[key].type, 'array');
    assertEquals(props[key].items.type, 'object');
  }
});

test('rewriteToolsForShim: umbrella tool is NOT strict (optional sub-properties incompatible with strict)', () => {
  const { tools } = rewriteToolsForShim([{ type: 'web_search' } as ResponseTool], undefined);
  assertEquals((tools[0] as { strict: boolean }).strict, false);
});

test('rewriteToolsForShim: extracts filters and user_location', () => {
  const { filters } = rewriteToolsForShim(
    [{
      type: 'web_search',
      filters: { allowed_domains: ['a.com'], blocked_domains: ['b.com'] },
      user_location: { country: 'JP', city: 'Tokyo' },
      search_context_size: 'high',
    } as ResponseTool],
    undefined,
  );
  assertEquals(filters.allowedDomains, ['a.com']);
  assertEquals(filters.blockedDomains, ['b.com']);
  assertEquals(filters.userLocation, { country: 'JP', city: 'Tokyo' });
  assertEquals(filters.maxResults, 40);
});

test('rewriteToolsForShim: maps search_context_size low → 10', () => {
  const { filters } = rewriteToolsForShim(
    [{ type: 'web_search', search_context_size: 'low' } as ResponseTool],
    undefined,
  );
  assertEquals(filters.maxResults, 10);
});

test('rewriteToolsForShim: maps search_context_size medium → 20', () => {
  const { filters } = rewriteToolsForShim(
    [{ type: 'web_search', search_context_size: 'medium' } as ResponseTool],
    undefined,
  );
  assertEquals(filters.maxResults, 20);
});

test('rewriteToolsForShim: maps search_context_size high → 40', () => {
  const { filters } = rewriteToolsForShim(
    [{ type: 'web_search', search_context_size: 'high' } as ResponseTool],
    undefined,
  );
  assertEquals(filters.maxResults, 40);
});

test('rewriteToolsForShim: omitted search_context_size defaults to medium (20 results)', () => {
  // Native default per openai-python `WebSearchTool.search_context_size`
  // docstring ("Defaults to 'medium'"). Without an explicit default the
  // shim used to leave `maxResults` unset, which made the provider fall
  // back to its own (smaller) baseline count — silently shrinking the
  // result set on requests that never thought about context size.
  const { filters } = rewriteToolsForShim(
    [{ type: 'web_search' } as ResponseTool],
    undefined,
  );
  assertEquals(filters.maxResults, 20);
});

test('rewriteToolsForShim: preserves non-web_search tools as-is alongside the umbrella', () => {
  const fn: ResponseTool = { type: 'function', name: 'foo', parameters: {}, strict: false };
  const { tools } = rewriteToolsForShim([fn, { type: 'web_search' } as ResponseTool], undefined);
  assertEquals(tools.length, 2);
  assertEquals(tools[0], fn);
  assertEquals((tools[1] as { name: string }).name, UMBRELLA);
});

test('rewriteToolsForShim: when no hosted web_search present, passes everything through unchanged', () => {
  const fn: ResponseTool = { type: 'function', name: 'foo', parameters: {}, strict: false };
  const { tools, filters, toolChoice, shimToolName } = rewriteToolsForShim([fn], 'auto');
  assertEquals(tools, [fn]);
  assertEquals(filters, {});
  assertEquals(toolChoice, 'auto');
  // shimToolName is still resolved because the reverse path needs it.
  assertEquals(shimToolName, UMBRELLA);
});

test('rewriteToolsForShim: multiple hosted entries inject the umbrella only once', () => {
  const { tools } = rewriteToolsForShim(
    [
      { type: 'web_search' } as unknown as ResponseTool,
      { type: 'web_search_preview' } as unknown as ResponseTool,
    ],
    undefined,
  );
  assertEquals(tools.length, 1);
  assertEquals((tools[0] as { name: string }).name, UMBRELLA);
});

for (const variant of HOSTED_VARIANTS) {
  test(`rewriteToolsForShim: rewrites tool_choice {type:"${variant}"} → function ${UMBRELLA}`, () => {
    const { toolChoice } = rewriteToolsForShim(
      [{ type: 'web_search' } as ResponseTool],
      { type: variant } as ResponseToolChoice,
    );
    assertEquals(toolChoice, { type: 'function', name: UMBRELLA });
  });
}

test('rewriteToolsForShim: passes through tool_choice "auto" / "none" / "required"', () => {
  for (const choice of ['auto', 'none', 'required'] as const) {
    const { toolChoice } = rewriteToolsForShim([{ type: 'web_search' } as ResponseTool], choice);
    assertEquals(toolChoice, choice);
  }
});

test('rewriteToolsForShim: tool_choice {type:"function", name:"x"} is preserved', () => {
  const choice: ResponseToolChoice = { type: 'function', name: 'foo' };
  const { toolChoice } = rewriteToolsForShim([{ type: 'web_search' } as ResponseTool], choice);
  assertEquals(toolChoice, choice);
});

test('rewriteToolsForShim: client function named web_search alongside hosted web_search → shim falls back to web_search_2', () => {
  const { tools, shimToolName } = rewriteToolsForShim(
    [
      { type: 'function', name: UMBRELLA, parameters: {}, strict: false },
      { type: 'web_search' } as ResponseTool,
    ],
    undefined,
  );
  assertEquals(shimToolName, `${UMBRELLA}_2`);
  assertEquals(tools.length, 2);
  assertEquals((tools[0] as { name: string }).name, UMBRELLA);
  assertEquals((tools[1] as { name: string }).name, `${UMBRELLA}_2`);
});

test('rewriteToolsForShim: client CUSTOM tool named web_search alongside hosted web_search → shim falls back to web_search_2', () => {
  const { tools, shimToolName } = rewriteToolsForShim(
    [
      { type: 'custom', name: UMBRELLA } as ResponseTool,
      { type: 'web_search' } as ResponseTool,
    ],
    undefined,
  );
  assertEquals(shimToolName, `${UMBRELLA}_2`);
  assertEquals(tools.length, 2);
  assertEquals((tools[0] as { name: string }).name, UMBRELLA);
  assertEquals((tools[1] as { name: string }).name, `${UMBRELLA}_2`);
});

test('rewriteToolsForShim: client functions named web_search AND web_search_2 → shim falls back to web_search_3', () => {
  const { tools, shimToolName } = rewriteToolsForShim(
    [
      { type: 'function', name: UMBRELLA, parameters: {}, strict: false },
      { type: 'function', name: `${UMBRELLA}_2`, parameters: {}, strict: false },
      { type: 'web_search' } as ResponseTool,
    ],
    undefined,
  );
  assertEquals(shimToolName, `${UMBRELLA}_3`);
  assertEquals(tools.length, 3);
  const names = tools.map(t => (t as { name: string }).name);
  assertEquals(names, [UMBRELLA, `${UMBRELLA}_2`, `${UMBRELLA}_3`]);
});

test('rewriteToolsForShim: hosted tool_choice resolves to the fallback umbrella name when present', () => {
  const { toolChoice, shimToolName } = rewriteToolsForShim(
    [
      { type: 'function', name: UMBRELLA, parameters: {}, strict: false },
      { type: 'web_search' } as ResponseTool,
    ],
    { type: 'web_search' } as ResponseToolChoice,
  );
  assertEquals(shimToolName, `${UMBRELLA}_2`);
  assertEquals(toolChoice, { type: 'function', name: `${UMBRELLA}_2` });
});

test('rewriteToolsForShim: client functions with unrelated names do not affect umbrella resolution', () => {
  const { shimToolName } = rewriteToolsForShim(
    [
      { type: 'function', name: 'foo', parameters: {}, strict: false },
      { type: 'function', name: 'bar', parameters: {}, strict: false },
      { type: 'web_search' } as ResponseTool,
    ],
    undefined,
  );
  assertEquals(shimToolName, UMBRELLA);
});

test('rewriteToolsForShim: no umbrella injection when no hosted web_search is present even if web_search is declared', () => {
  const { tools, shimToolName } = rewriteToolsForShim(
    [{ type: 'function', name: UMBRELLA, parameters: {}, strict: false }],
    undefined,
  );
  assertEquals(tools.length, 1);
  assertEquals(shimToolName, `${UMBRELLA}_2`);
});

test('resolveShimToolName: returns the default when no names are taken', () => {
  assertEquals(resolveShimToolName([]), UMBRELLA);
});

test('resolveShimToolName: skips taken names sequentially', () => {
  assertEquals(resolveShimToolName([UMBRELLA]), `${UMBRELLA}_2`);
  assertEquals(resolveShimToolName([UMBRELLA, `${UMBRELLA}_2`]), `${UMBRELLA}_3`);
  assertEquals(resolveShimToolName([UMBRELLA, `${UMBRELLA}_2`, `${UMBRELLA}_3`]), `${UMBRELLA}_4`);
});

test('rewriteToolsForShim: user_location surfaces in umbrella description', () => {
  const { tools } = rewriteToolsForShim(
    [{ type: 'web_search', user_location: { city: 'Tokyo', region: 'Tokyo', country: 'Japan', timezone: 'Asia/Tokyo' } } as ResponseTool],
    undefined,
  );
  const umbrella = tools[0] as { description: string; name: string };
  assertEquals(umbrella.name, UMBRELLA);
  assertEquals(typeof umbrella.description, 'string');
  assertEquals(umbrella.description.includes('Default user location: Tokyo, Japan (timezone: Asia/Tokyo)'), true);
  assertEquals(umbrella.description.includes('default when the user asks about local information'), true);
});

test('rewriteToolsForShim: user_location without timezone formats without the parenthetical', () => {
  const { tools } = rewriteToolsForShim(
    [{ type: 'web_search', user_location: { city: 'San Francisco', country: 'United States' } } as ResponseTool],
    undefined,
  );
  const desc = (tools[0] as { description: string }).description;
  assertEquals(desc.includes('Default user location: San Francisco, United States.'), true);
  assertEquals(desc.includes('timezone'), false);
});

test('rewriteToolsForShim: no user_location keeps the base description (no location hint)', () => {
  const { tools } = rewriteToolsForShim([{ type: 'web_search' } as ResponseTool], undefined);
  const desc = (tools[0] as { description: string }).description;
  assertEquals(desc.includes('Default user location'), false);
});

test('rewriteToolsForShim: user_location with identical city and region dedupes to one segment', () => {
  const { tools } = rewriteToolsForShim(
    [{ type: 'web_search', user_location: { city: 'Tokyo', region: 'Tokyo', country: 'Japan' } } as ResponseTool],
    undefined,
  );
  const desc = (tools[0] as { description: string }).description;
  assertEquals(desc.includes('Default user location: Tokyo, Japan'), true);
  assertEquals(desc.includes('Tokyo, Tokyo'), false);
});

test('rewriteToolsForShim: user_location with only timezone formats without leading separator', () => {
  const { tools } = rewriteToolsForShim(
    [{ type: 'web_search', user_location: { timezone: 'Asia/Tokyo' } } as ResponseTool],
    undefined,
  );
  const desc = (tools[0] as { description: string }).description;
  assertEquals(desc.includes('Default user location: (timezone: Asia/Tokyo).'), true);
  assertEquals(desc.includes('Default user location:  '), false);
});

test('rewriteToolsForShim: tool_choice "required" passes through unchanged (gateway demote handled in main loop)', () => {
  const { toolChoice } = rewriteToolsForShim([{ type: 'web_search' } as ResponseTool], 'required');
  assertEquals(toolChoice, 'required');
});
