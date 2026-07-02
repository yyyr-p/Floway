import { describe, expect, test } from 'vitest';

import { applyRewrite, applyStops, cursorAtBoundary, extractInsertion, parsePrefixSuffix } from './completions.ts';

describe('parsePrefixSuffix', () => {
  test('explicit OpenAI suffix field (no trimming)', () => {
    expect(parsePrefixSuffix('def f():\n    return ', '\n\nprint(f())')).toEqual({ prefix: 'def f():\n    return ', suffix: '\n\nprint(f())' });
  });
  test('StarCoder FIM tokens, byte-exact (keeps trailing space)', () => {
    expect(parsePrefixSuffix('<fim_prefix>def f():\n    return <fim_suffix>\n\nx<fim_middle>')).toEqual({ prefix: 'def f():\n    return ', suffix: '\n\nx' });
  });
  test('CodeLlama spaces are delimiters', () => {
    expect(parsePrefixSuffix('<PRE> A <SUF>B <MID>')).toEqual({ prefix: 'A', suffix: 'B' });
  });
  test('Qwen / DeepSeek / GLM triples', () => {
    expect(parsePrefixSuffix('<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>')).toEqual({ prefix: 'P', suffix: 'S' });
    expect(parsePrefixSuffix('<｜fim▁begin｜>P<｜fim▁hole｜>S<｜fim▁end｜>')).toEqual({ prefix: 'P', suffix: 'S' });
    expect(parsePrefixSuffix('<|code_prefix|>P<|code_suffix|>S<|code_middle|>')).toEqual({ prefix: 'P', suffix: 'S' });
  });
  test('Codestral reversed order', () => {
    expect(parsePrefixSuffix('[SUFFIX]S[PREFIX]P')).toEqual({ prefix: 'P', suffix: 'S' });
  });
  test('plain prompt → all prefix', () => {
    expect(parsePrefixSuffix('hello world')).toEqual({ prefix: 'hello world', suffix: '' });
  });
});

describe('cursorAtBoundary', () => {
  test('line/column at end of prefix', () => {
    expect(cursorAtBoundary('def f():\n    return ')).toEqual({ line: 1, column: 11 });
    expect(cursorAtBoundary('x')).toEqual({ line: 0, column: 1 });
  });
});

describe('applyRewrite', () => {
  test('replaces a 1-indexed inclusive line range', () => {
    expect(applyRewrite('a\nb\nc', { startLineNumber: 2, endLineNumberInclusive: 2 }, 'B\n')).toBe('a\nB\nc');
  });
  test('no range → replaces the whole file verbatim', () => {
    expect(applyRewrite('a\nb', undefined, 'x\ny\n')).toBe('x\ny\n');
  });
});

describe('extractInsertion', () => {
  const ps = { prefix: 'def f():\n    return ', suffix: '\n\nprint(f())' };
  test('pure insertion when prefix + suffix are preserved', () => {
    // whole-file rewrite (no range) = the file with "a + b" inserted at cursor
    const text = 'def f():\n    return a + b\n\nprint(f())\n';
    expect(extractInsertion(ps, undefined, text)).toBe('a + b');
  });
  test('empty when the model rewrote the prefix (not a clean insertion)', () => {
    const text = 'def g():\n    return a + b\n\nprint(f())\n';
    expect(extractInsertion(ps, undefined, text)).toBe('');
  });
  test('empty text → empty insertion', () => {
    expect(extractInsertion(ps, undefined, '')).toBe('');
  });
});

describe('applyStops', () => {
  test('truncates at the first stop sequence', () => {
    expect(applyStops('a + b\ndef next', ['\ndef '])).toBe('a + b');
    expect(applyStops('a + b', undefined)).toBe('a + b');
    expect(applyStops('a\nb', '\n')).toBe('a');
  });
});
