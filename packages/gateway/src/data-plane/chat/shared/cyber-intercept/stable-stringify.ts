// Deterministic JSON serialization for the judge request's payload.
//
// The judge request embeds the caller's request payload as a JSON string
// inside the user message. Prompt-cache prefix matching is byte-exact, so
// the same logical payload must serialize to the same string every time:
// object keys are sorted lexicographically (field order in the raw request
// carries no semantics), arrays keep their order (messages order is
// semantic), and no whitespace is inserted (compact form maximizes the
// shared prefix length).
const stableStringifyValue = (value: unknown): string => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringifyValue(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableStringifyValue(v)}`).join(',')}}`;
  }
  // undefined at the top level (or inside an array slot) is the only
  // remaining case; JSON.stringify renders both as null-ish.
  return 'null';
};

export const stableStringify = (value: unknown): string => stableStringifyValue(value);
