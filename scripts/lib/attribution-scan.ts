// Scans text for attribution (see attribution-patterns.ts) twice:
// - line by line, as written, which catches trailers and emoji;
// - as one normalized stream of words for the whole document, so that markup,
//   emphasis, line breaks and invisible characters cannot split or hide a credit.
//
// Normalizing:
// - inline (phrasing) tags, HTML comments, soft hyphens and zero-width
//   characters (and their character references) are removed with no word
//   boundary, so "Cur<b>sor</b>", "Cur<!-- -->sor" and "Cur&shy;sor" read as one word;
// - every other tag and Markdown link targets become a word boundary;
// - punctuation, emphasis and line breaks are dropped between words.
// Every finding names the source line where the match starts.

import { ATTRIBUTION_PATTERNS } from "./attribution-patterns.ts";

const INLINE_TAGS = [
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
];

/** Removed without leaving a boundary. */
const JOINING = new RegExp(
  [
    `<\\/?(?:${INLINE_TAGS.join("|")})(?:\\s[^>]*)?\\/?>`,
    "<!--[\\s\\S]*?-->",
    "[\\u00AD\\u200B-\\u200D\\u2060\\uFEFF]",
    "&(?:shy|zwsp|zwj|zwnj|ZeroWidthSpace|NoBreak|NegativeVeryThinSpace|NegativeThinSpace|NegativeMediumSpace|NegativeThickSpace);",
    "&#(?:0*173|0*820[3-5]|0*8288|0*65279);",
    "&#[xX]0*(?:ad|200[bBcCdD]|2060|[fF][eE][fF][fF]);",
  ].join("|"),
  "gi",
);
/**
 * Comments, each scanned as its own stream: HTML <!-- -->, /* *\/ blocks, and
 * runs of consecutive lines starting with // or #. The markers are dropped by
 * the word tokenizer; a nested "<!--" is not special inside a comment body.
 */
const COMMENTS =
  /<!--[\s\S]*?(?:-->|(?![\s\S]))|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|(?:^[ \t]*(?:\/\/|#)[^\n]*(?:\n|(?![\s\S])))+/gm;

/** Replaced by a word boundary. */
const BREAKING = /<[^>]*>|\]\([^)\s]*\)/g;

const WORD = /[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu;

/** Text with joining markup removed and breaking markup turned into spaces, and each character's source offset. */
function normalizeMarkup(text: string): { clean: string; offsets: number[] } {
  const removals: Array<[number, number, string]> = [];
  for (const m of text.matchAll(JOINING)) removals.push([m.index ?? 0, (m.index ?? 0) + m[0].length, ""]);
  for (const m of text.matchAll(BREAKING)) removals.push([m.index ?? 0, (m.index ?? 0) + m[0].length, " "]);
  removals.sort((x, y) => x[0] - y[0] || y[1] - x[1]);

  let clean = "";
  const offsets: number[] = [];
  let i = 0;
  for (const [start, end, replacement] of removals) {
    if (start < i) continue; // inside an earlier removal
    for (; i < start; i += 1) {
      clean += text[i];
      offsets.push(i);
    }
    if (replacement !== "") {
      clean += replacement;
      offsets.push(start);
    }
    i = end;
  }
  for (; i < text.length; i += 1) {
    clean += text[i];
    offsets.push(i);
  }
  return { clean, offsets };
}

/** Strips the invisible characters attributions could hide behind; for text a browser has already decoded. */
export function stripInvisible(text: string): string {
  return text.replace(/[­​-‍⁠﻿]/g, "");
}

export function scanText(where: string, text: string): string[] {
  const findings = new Map<string, string>();
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const report = (line: number, label: string, excerpt: string) => {
    const key = `${line}\0${label}`;
    if (!findings.has(key)) findings.set(key, `${where}:${line}: ${label}: ${excerpt.trim().slice(0, 120)}`);
  };

  const lines = text.split("\n");
  for (const [label, pattern] of ATTRIBUTION_PATTERNS) {
    lines.forEach((line, i) => {
      if (pattern.test(line) || pattern.test(stripInvisible(line))) report(i + 1, label, line);
    });
  }

  // One normalized stream over a span of the source: the whole text, or one comment's body.
  const scanStream = (start: number, end: number, reportAt?: number) => {
    const { clean, offsets } = normalizeMarkup(text.slice(start, end));
    const words = [...clean.matchAll(WORD)];
    const starts: number[] = [];
    let normalized = "";
    for (const w of words) {
      starts.push(normalized.length);
      normalized += `${w[0]} `;
    }
    for (const [label, pattern] of ATTRIBUTION_PATTERNS) {
      const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      for (const match of normalized.matchAll(global)) {
        let w = starts.findIndex((s) => s > (match.index ?? 0)) - 1;
        if (w < 0) w = starts.length - 1;
        const offset = reportAt ?? start + (offsets[words[w]?.index ?? 0] ?? 0);
        report(lineOf(offset), label, match[0]);
      }
    }
  };

  scanStream(0, text.length);
  // The stream above drops HTML comments; scan every comment body on its own,
  // reporting the comment's first line.
  for (const m of text.matchAll(COMMENTS)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // Scan the body of an HTML comment without its delimiters, which the stream would remove whole.
    const html = m[0].startsWith("<!--");
    scanStream(html ? start + 4 : start, html && m[0].endsWith("-->") ? end - 3 : end, start);
  }
  return [...findings.values()];
}
