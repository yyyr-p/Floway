/**
 * Cursor Tab (StreamCpp) → OpenAI /v1/completions bridge helpers.
 *
 * Phase 2: the FIM / plain-prompt path. An incoming `/v1/completions` prompt is
 * split into prefix/suffix (FIM tokens or plain), turned into a StreamCpp
 * request (contents = prefix+suffix, cursor at the prefix/suffix boundary), and
 * the model's rewritten region is reduced back to the pure insertion the FIM
 * client expects. Zeta marker formats (V0318/V0615) are layered on in Phase 3.
 */

import type { StreamCppLineRange, StreamCppRequestInput } from './proto/stream-cpp.ts';

export interface PrefixSuffix {
  prefix: string;
  suffix: string;
}

// Fill-in-the-middle token triples (prefix / suffix / middle), matching the
// formats Zed's fim.rs and other clients emit. Delimiter whitespace (e.g.
// CodeLlama's spaces) is baked into the markers so the extracted prefix/suffix
// stay byte-exact — trimming would corrupt cursor-adjacent whitespace. Order
// matters: more specific (multi-char) markers are tried first.
const FIM_TRIPLES: readonly { pre: string; suf: string; mid: string }[] = [
  { pre: '<｜fim▁begin｜>', suf: '<｜fim▁hole｜>', mid: '<｜fim▁end｜>' }, // DeepSeek
  { pre: '<|fim_prefix|>', suf: '<|fim_suffix|>', mid: '<|fim_middle|>' }, // Qwen / CodeGemma
  { pre: '<|code_prefix|>', suf: '<|code_suffix|>', mid: '<|code_middle|>' }, // GLM
  { pre: '<fim_prefix>', suf: '<fim_suffix>', mid: '<fim_middle>' }, // StarCoder
  { pre: '<PRE> ', suf: ' <SUF>', mid: ' <MID>' }, // CodeLlama (spaces are delimiters)
];

// Parse a completions `prompt` into prefix/suffix. Handles the FIM token
// triples above, Codestral's reversed [SUFFIX]…[PREFIX]…, and an explicit
// OpenAI `suffix` field; falls back to treating the whole prompt as the prefix.
export const parsePrefixSuffix = (prompt: string, explicitSuffix?: string): PrefixSuffix => {
  if (explicitSuffix !== undefined) return { prefix: prompt, suffix: explicitSuffix };

  for (const { pre, suf, mid } of FIM_TRIPLES) {
    const pi = prompt.indexOf(pre);
    const si = prompt.indexOf(suf);
    const mi = prompt.indexOf(mid);
    if (pi !== -1 && si > pi && mi > si) {
      return { prefix: prompt.slice(pi + pre.length, si), suffix: prompt.slice(si + suf.length, mi) };
    }
  }

  // Codestral: [SUFFIX]{suffix}[PREFIX]{prefix}
  const csSuf = prompt.indexOf('[SUFFIX]');
  const csPre = prompt.indexOf('[PREFIX]');
  if (csSuf !== -1 && csPre > csSuf) {
    return { prefix: prompt.slice(csPre + '[PREFIX]'.length), suffix: prompt.slice(csSuf + '[SUFFIX]'.length, csPre) };
  }

  return { prefix: prompt, suffix: '' };
};

// Cursor position at the prefix/suffix boundary within contents = prefix+suffix.
export const cursorAtBoundary = (prefix: string): { line: number; column: number } => {
  const before = prefix.split('\n');
  return { line: before.length - 1, column: before[before.length - 1].length };
};

export const streamCppInputForPrefixSuffix = (ps: PrefixSuffix, opts: { relativePath: string; languageId: string; modelName: string }): StreamCppRequestInput => {
  const pos = cursorAtBoundary(ps.prefix);
  return {
    relativePath: opts.relativePath,
    contents: ps.prefix + ps.suffix,
    cursorLine: pos.line,
    cursorColumn: pos.column,
    languageId: opts.languageId,
    modelName: opts.modelName,
  };
};

// Apply StreamCpp's rewritten-region `text` to the original file, replacing the
// 1-indexed inclusive `range` (whole file when no range was emitted). Operates
// on character offsets so `text` is spliced in verbatim — Cursor's replacement
// carries the trailing newline of its last line, which a line-array splice
// would drop when the range reaches the end of the file.
export const applyRewrite = (contents: string, range: StreamCppLineRange | undefined, text: string): string => {
  if (!range) return text;
  const lines = contents.split('\n');
  const start = range.startLineNumber - 1;
  const end = range.endLineNumberInclusive - 1;
  if (start < 0 || start > lines.length) return contents;
  let startOff = 0;
  for (let i = 0; i < start; i++) startOff += lines[i].length + 1;
  let endOff = startOff;
  for (let i = start; i <= end && i < lines.length; i++) endOff += lines[i].length + 1;
  endOff = Math.min(endOff, contents.length);
  return contents.slice(0, startOff) + text + contents.slice(endOff);
};

// Reduce the rewritten file to the pure insertion at the cursor: the text that
// sits between the original prefix and suffix. Returns '' when the model's edit
// isn't a clean cursor-anchored insertion (it rewrote prefix/suffix) — the FIM
// client then simply shows no suggestion. Tolerates a trailing-newline mismatch
// at EOF (Cursor's rewrite carries the final line's newline; the client's
// suffix may or may not).
export const extractInsertion = (ps: PrefixSuffix, range: StreamCppLineRange | undefined, text: string): string => {
  if (!text) return '';
  const rewritten = applyRewrite(ps.prefix + ps.suffix, range, text);
  if (!rewritten.startsWith(ps.prefix)) return '';
  let mid = rewritten.slice(ps.prefix.length);
  if (ps.suffix) {
    if (mid.endsWith(ps.suffix)) mid = mid.slice(0, mid.length - ps.suffix.length);
    else if (mid.endsWith(`${ps.suffix}\n`)) mid = mid.slice(0, mid.length - ps.suffix.length - 1);
    else if (ps.suffix.endsWith('\n') && mid.endsWith(ps.suffix.slice(0, -1))) mid = mid.slice(0, mid.length - ps.suffix.length + 1);
    else return '';
  }
  return mid;
};

// Truncate a completion at the first stop sequence (OpenAI `stop` semantics).
export const applyStops = (text: string, stop: string | readonly string[] | undefined): string => {
  if (!stop) return text;
  const stops = (Array.isArray(stop) ? stop : [stop]).filter((s): s is string => typeof s === 'string' && s.length > 0);
  let out = text;
  for (const s of stops) {
    const i = out.indexOf(s);
    if (i !== -1) out = out.slice(0, i);
  }
  return out;
};

// A minimal, well-formed OpenAI text_completion body for the passthrough serve.
export const completionsResponseBody = (model: string, text: string): string =>
  JSON.stringify({
    id: `cmpl-cursor-${crypto.randomUUID()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ text, index: 0, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

// Rough language id from a file extension / OpenAI-style hint.
export const languageIdForCompletion = (body: { language?: unknown; suffix?: unknown }): string =>
  (typeof body.language === 'string' && body.language) || 'plaintext';
