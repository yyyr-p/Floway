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
  test('replaces a single line (text ends in newline)', () => {
    expect(applyRewrite('a\nb\nc', { startLineNumber: 2, endLine: 3 }, 'B\n')).toBe('a\nB\nc');
  });
  test('no range → replaces the whole file verbatim', () => {
    expect(applyRewrite('a\nb', undefined, 'x\ny\n')).toBe('x\ny\n');
  });
  // Regressions for the observed Zed bugs: the replaced span must contain
  // exactly as many newlines as `text`, so the end line's inclusive/exclusive
  // ambiguity never swallows a following line or duplicates the last one.
  test('text without trailing newline does not duplicate the landing line', () => {
    // Restate lines 1-6 as-is (no trailing newline) over a 6-line-then-blanks file.
    const file = 'def f():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n\n\nf()\n';
    const text = 'def f():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5';
    expect(applyRewrite(file, { startLineNumber: 1, endLine: 6 }, text)).toBe(file);
  });
  test('text with trailing newline does not swallow the following blank line', () => {
    const file = 'def f():\n    a = 1\n    b = 2\n\n\nf()\n';
    const text = '    a = 1\n    b = 2\n';
    expect(applyRewrite(file, { startLineNumber: 2, endLine: 4 }, text)).toBe(file);
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
