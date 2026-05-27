import { test } from 'vitest';

import { parseArgs, parseUmbrellaOperations, type ShimLogicalOperation } from './umbrella-args.ts';
import { assert, assertEquals } from '../../../../../../test-assert.ts';

const opsOf = (json: string): ShimLogicalOperation[] => {
  const parsed = parseUmbrellaOperations(json);
  assert(parsed.kind === 'ops');
  return parsed.ops;
};

test('parseUmbrellaOperations returns ops:[] for empty object', () => {
  assertEquals(parseUmbrellaOperations('{}'), { kind: 'ops', ops: [] });
});

test('parseUmbrellaOperations repairs malformed JSON via jsonrepair', () => {
  // `'{not json'` repairs to `{"not json": null}`; the recovered key
  // isn't one of the supported sub-properties.
  assertEquals(parseUmbrellaOperations('{not json'), {
    kind: 'ops',
    ops: [{ kind: 'unsupported', subProperty: 'not json', arrayIndex: 0 }],
  });
});

test('parseUmbrellaOperations returns malformed for non-object JSON (array)', () => {
  assertEquals(parseUmbrellaOperations('[1,2,3]'), { kind: 'malformed' });
});

test('parseUmbrellaOperations parses one search_query entry', () => {
  assertEquals(
    opsOf(JSON.stringify({ search_query: [{ q: 'hello' }] })),
    [{ kind: 'search', arrayIndex: 0, query: 'hello' }],
  );
});

test('parseUmbrellaOperations parses multiple search_query entries with stable arrayIndex', () => {
  assertEquals(
    opsOf(JSON.stringify({ search_query: [{ q: 'a' }, { q: 'b' }, { q: 'c' }] })),
    [
      { kind: 'search', arrayIndex: 0, query: 'a' },
      { kind: 'search', arrayIndex: 1, query: 'b' },
      { kind: 'search', arrayIndex: 2, query: 'c' },
    ],
  );
});

test('parseUmbrellaOperations parses open entry with URL ref_id', () => {
  assertEquals(
    opsOf(JSON.stringify({ open: [{ ref_id: 'https://example.com' }] })),
    [{ kind: 'open', arrayIndex: 0, url: 'https://example.com' }],
  );
});

test('parseUmbrellaOperations parses find entry with URL ref_id and pattern', () => {
  assertEquals(
    opsOf(JSON.stringify({ find: [{ ref_id: 'https://example.com', pattern: 'needle' }] })),
    [{ kind: 'find', arrayIndex: 0, url: 'https://example.com', pattern: 'needle' }],
  );
});

test('parseUmbrellaOperations: non-URL open ref_id produces an error sentinel', () => {
  const ops = opsOf(JSON.stringify({ open: [{ ref_id: 'opaque-prior-id' }] }));
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'open');
  assertEquals((op as { url: string }).url, 'opaque-prior-id');
  const err = (op as { error?: string }).error;
  assertEquals(typeof err, 'string');
  assertEquals(err!.startsWith('Error: ref_id must be a fully-qualified URL'), true);
  assertEquals(err!.includes('opaque-prior-id'), true);
});

test('parseUmbrellaOperations: non-URL find ref_id produces an error sentinel', () => {
  const ops = opsOf(JSON.stringify({ find: [{ ref_id: 'cursor-123', pattern: 'p' }] }));
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'find');
  assertEquals((op as { url: string }).url, 'cursor-123');
  assertEquals((op as { pattern: string }).pattern, 'p');
  const err = (op as { error?: string }).error;
  assertEquals(typeof err, 'string');
  assertEquals(err!.includes('cursor-123'), true);
});

test('parseUmbrellaOperations: multi-action batched call returns all ops in order search→open→find', () => {
  const ops = opsOf(JSON.stringify({
    search_query: [{ q: 'a' }],
    open: [{ ref_id: 'https://x' }],
    find: [{ ref_id: 'https://y', pattern: 'p' }],
  }));
  assertEquals(ops.map(o => o.kind), ['search', 'open', 'find']);
});

test('parseUmbrellaOperations: unsupported sub-properties surface one unsupported op per entry', () => {
  const ops = opsOf(JSON.stringify({
    click: [{ ref_id: 'https://x', id: 1 }],
    screenshot: [{ ref_id: 'https://x', pageno: 1 }, { ref_id: 'https://y', pageno: 2 }],
    weather: [{ location: 'NYC' }],
    response_length: 'short',
    search_query: [{ q: 'real' }],
  }));
  assertEquals(ops.length, 6);
  assertEquals(ops[0], { kind: 'search', arrayIndex: 0, query: 'real' });
  assertEquals(ops[1], { kind: 'unsupported', subProperty: 'click', arrayIndex: 0 });
  assertEquals(ops[2], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 0 });
  assertEquals(ops[3], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 1 });
  assertEquals(ops[4], { kind: 'unsupported', subProperty: 'weather', arrayIndex: 0 });
  assertEquals(ops[5], { kind: 'unsupported', subProperty: 'response_length', arrayIndex: 0 });
});

test('parseUmbrellaOperations: missing q on search_query entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf(JSON.stringify({ search_query: [{}] }));
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'search');
  assertEquals((op as { query: string }).query, '');
  assertEquals(typeof (op as { error?: string }).error, 'string');
  assert((op as { error: string }).error.includes('"q"'));
});

test('parseUmbrellaOperations: missing ref_id on open entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf(JSON.stringify({ open: [{}] }));
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'open');
  assertEquals((op as { url: string }).url, '');
  assert((op as { error: string }).error.includes('"ref_id"'));
});

test('parseUmbrellaOperations: missing pattern on find entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf(JSON.stringify({ find: [{ ref_id: 'https://x' }] }));
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'find');
  assertEquals((op as { pattern: string }).pattern, '');
  assert((op as { error: string }).error.includes('"pattern"'));
});

test('parseUmbrellaOperations: array values for non-array shape are skipped', () => {
  assertEquals(opsOf(JSON.stringify({ search_query: 'oops' })), [
    { kind: 'wrong-type', subProperty: 'search_query', actualType: 'string' },
  ]);
});

test('parseUmbrellaOperations: supported key with non-array value surfaces a wrong-type op (search_query)', () => {
  // A model that populates `search_query: {"q":"x"}` (or any
  // non-array) used to be silently dropped because the array guard
  // skipped it. Surface as a model-visible `wrong-type` op so the
  // model learns the call was malformed instead of seeing a phantom
  // success.
  assertEquals(opsOf(JSON.stringify({ search_query: { q: 'x' } })), [
    { kind: 'wrong-type', subProperty: 'search_query', actualType: 'object' },
  ]);
});

test('parseUmbrellaOperations: wrong-typed supported key does not block other supported keys from executing', () => {
  const ops = opsOf(JSON.stringify({ search_query: { q: 'x' }, open: [{ ref_id: 'https://y' }] }));
  assertEquals(ops.length, 2);
  assertEquals(ops[0], { kind: 'wrong-type', subProperty: 'search_query', actualType: 'object' });
  assertEquals(ops[1], { kind: 'open', arrayIndex: 0, url: 'https://y' });
});

test('parseUmbrellaOperations: wrong-typed open / find surface as wrong-type ops', () => {
  assertEquals(opsOf(JSON.stringify({ open: 'https://x' })), [
    { kind: 'wrong-type', subProperty: 'open', actualType: 'string' },
  ]);
  assertEquals(opsOf(JSON.stringify({ find: null })), [
    { kind: 'wrong-type', subProperty: 'find', actualType: 'null' },
  ]);
});

test('parseArgs returns kind=object,value={} for empty string', () => {
  assertEquals(parseArgs(''), { kind: 'object', value: {} });
});

test('parseArgs returns kind=object for valid JSON object', () => {
  assertEquals(parseArgs('{"query":"hi","topn":5}'), { kind: 'object', value: { query: 'hi', topn: 5 } });
});

test('parseArgs returns kind=malformed for valid JSON array', () => {
  assertEquals(parseArgs('[1,2,3]'), { kind: 'malformed' });
});

test('parseArgs returns kind=malformed for valid JSON primitive (string)', () => {
  assertEquals(parseArgs('"hello"'), { kind: 'malformed' });
});

test('parseArgs returns kind=malformed for valid JSON primitive (number)', () => {
  assertEquals(parseArgs('42'), { kind: 'malformed' });
});

test('parseArgs returns kind=malformed for valid JSON null', () => {
  assertEquals(parseArgs('null'), { kind: 'malformed' });
});

test('parseArgs returns kind=malformed for input jsonrepair cannot coerce to an object', () => {
  // jsonrepair wraps `'!@#$%^'` as a JSON string; still not an object.
  assertEquals(parseArgs('!@#$%^'), { kind: 'malformed' });
});

test('parseArgs preserves nested object values', () => {
  assertEquals(parseArgs('{"a":{"b":1},"c":[2,3]}'), { kind: 'object', value: { a: { b: 1 }, c: [2, 3] } });
});
