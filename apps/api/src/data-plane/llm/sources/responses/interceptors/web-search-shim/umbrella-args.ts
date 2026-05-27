// Parses one umbrella function_call's arguments into a flat list of
// logical operations. 13 documented sub-properties total; shim
// implements 3 (search/open/find), the other 10 surface as
// `unsupported` ops.

import { jsonrepair } from 'jsonrepair';

export type ShimOperationErrorKind = 'invalid-ref' | 'missing-arg';

export type ShimLogicalOperation =
  | {
    kind: 'search';
    /** Original index inside the umbrella's `search_query` array. */
    arrayIndex: number;
    query: string;
    /** When set, dispatch returns this verbatim instead of hitting the backend. */
    error?: string;
    errorKind?: ShimOperationErrorKind;
  }
  | {
    kind: 'open';
    arrayIndex: number;
    error?: string;
    errorKind?: ShimOperationErrorKind;
    url: string;
  }
  | {
    kind: 'find';
    arrayIndex: number;
    error?: string;
    errorKind?: ShimOperationErrorKind;
    url: string;
    pattern: string;
  }
  | {
    kind: 'unsupported';
    /** The umbrella sub-property name the model populated (e.g. `click`). */
    subProperty: string;
    /** Original index inside that sub-property's array. */
    arrayIndex: number;
  }
  | {
    kind: 'wrong-type';
    subProperty: 'search_query' | 'open' | 'find';
    actualType: string;
  };

export type ParsedUmbrella =
  | { kind: 'ops'; ops: ShimLogicalOperation[] }
  | { kind: 'malformed' };

// jsonrepair-then-parse: handles valid JSON unchanged and salvages
// common malformations (unquoted keys, trailing commas, missing braces,
// single quotes). One attempt; either we get an object or the call
// surfaces as malformed and flows to the schema-error path. Empty
// string short-circuits to the empty object.
type ParseArgsResult =
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'malformed' };

export const parseArgs = (argumentsJson: string): ParseArgsResult => {
  if (argumentsJson === '') return { kind: 'object', value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(argumentsJson));
  } catch {
    return { kind: 'malformed' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'malformed' };
  }
  return { kind: 'object', value: parsed as Record<string, unknown> };
};

// Stricter than `/^https?:\/\//i`: that regex accepts `https://` (empty
// host). Reject malformed refs at parse time so dispatch always sees a
// well-formed URL.
const isUrl = (s: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname === '') return false;
  return true;
};

const refIdError = (refId: string): string =>
  `Error: ref_id must be a fully-qualified URL in the gateway shim (got '${refId}'). The gateway shim does not preserve prior-call ids across turns.`;

const missingArgError = (field: string): string =>
  `Error: missing required argument "${field}".`;

const SUPPORTED_KEYS: ReadonlySet<string> = new Set(['search_query', 'open', 'find']);

export const parseUmbrellaOperations = (argumentsJson: string): ParsedUmbrella => {
  const parsed = parseArgs(argumentsJson);
  if (parsed.kind === 'malformed') return { kind: 'malformed' };
  const args = parsed.value;
  const ops: ShimLogicalOperation[] = [];

  // Surface wrong-typed keys as visible IRs.
  const describeType = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

  const searchQuery = args.search_query;
  if (searchQuery !== undefined) {
    if (!Array.isArray(searchQuery)) {
      ops.push({ kind: 'wrong-type', subProperty: 'search_query', actualType: describeType(searchQuery) });
    } else {
      for (let i = 0; i < searchQuery.length; i++) {
        const entry = searchQuery[i];
        const q = entry !== null && typeof entry === 'object' && 'q' in entry && typeof entry.q === 'string'
          ? entry.q
          : '';
        if (q === '') {
          ops.push({ kind: 'search', arrayIndex: i, query: '', error: missingArgError('q'), errorKind: 'missing-arg' });
          continue;
        }
        ops.push({ kind: 'search', arrayIndex: i, query: q });
      }
    }
  }

  const open = args.open;
  if (open !== undefined) {
    if (!Array.isArray(open)) {
      ops.push({ kind: 'wrong-type', subProperty: 'open', actualType: describeType(open) });
    } else {
      for (let i = 0; i < open.length; i++) {
        const entry = open[i];
        const refId = entry !== null && typeof entry === 'object' && 'ref_id' in entry && typeof entry.ref_id === 'string'
          ? entry.ref_id
          : '';
        if (refId === '') {
          ops.push({ kind: 'open', arrayIndex: i, url: '', error: missingArgError('ref_id'), errorKind: 'missing-arg' });
          continue;
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'open', arrayIndex: i, url: refId, error: refIdError(refId), errorKind: 'invalid-ref' });
          continue;
        }
        ops.push({ kind: 'open', arrayIndex: i, url: refId });
      }
    }
  }

  const find = args.find;
  if (find !== undefined) {
    if (!Array.isArray(find)) {
      ops.push({ kind: 'wrong-type', subProperty: 'find', actualType: describeType(find) });
    } else {
      for (let i = 0; i < find.length; i++) {
        const entry = find[i];
        const refId = entry !== null && typeof entry === 'object' && 'ref_id' in entry && typeof entry.ref_id === 'string'
          ? entry.ref_id
          : '';
        const pattern = entry !== null && typeof entry === 'object' && 'pattern' in entry && typeof entry.pattern === 'string'
          ? entry.pattern
          : '';
        if (refId === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: '', pattern, error: missingArgError('ref_id'), errorKind: 'missing-arg' });
          continue;
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern, error: refIdError(refId), errorKind: 'invalid-ref' });
          continue;
        }
        if (pattern === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern: '', error: missingArgError('pattern'), errorKind: 'missing-arg' });
          continue;
        }
        ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern });
      }
    }
  }

  // Top-level keys outside `search_query` / `open` / `find` surface as
  // one `unsupported` op per array entry (or a single op for a scalar).
  for (const key of Object.keys(args)) {
    if (SUPPORTED_KEYS.has(key)) continue;
    const value = args[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: i });
      }
    } else {
      ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: 0 });
    }
  }

  return {
    kind: 'ops',
    ops,
  };
};

export const unsupportedSubPropertyText = (subProperty: string): string =>
  `Error: the \`${subProperty}\` sub-property is not supported by this gateway. `
  + 'Only `search_query`, `open`, and `find` are available.';

export const wrongTypeSubPropertyText = (subProperty: string, actualType: string): string =>
  `Error: the \`${subProperty}\` sub-property must be an array of objects; got ${actualType}.`;
