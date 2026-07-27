/**
 * Text normalization for Google Docs content.
 *
 * Two different notions of "text" collide here and conflating them corrupts documents:
 *
 *   - **Raw text** is what Google's indices address. One raw UTF-16 code unit == one index.
 *     Any range we send to `batchUpdate` must be expressed in raw offsets.
 *   - **Normalized text** is what we match against. Docs silently rewrites straight quotes into
 *     curly ones, spaces into non-breaking spaces, hyphens into en dashes. An agent asking to
 *     replace `"don't"` will never find `“don’t”` without normalization.
 *
 * Normalization is therefore never destructive: `normalizeWithMap` returns the normalized string
 * *and* an offset map back to raw positions, so a match found in normalized space can be
 * converted to a raw range with no drift.
 */

/** Docs uses a vertical tab for a soft line break (Shift+Enter) inside a paragraph. */
export const SOFT_BREAK = "";

/**
 * Characters that Docs substitutes for typed ASCII, mapped back to their ASCII origin so that
 * agent-supplied plain text matches document content.
 */
const CHAR_FOLDS: Record<string, string> = {
  // Curly quotes and primes -> straight
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "″": '"',
  // Dashes -> hyphen
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  // Spaces of every width -> plain space
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  "　": " ",
  // Soft line break reads as a newline
  [SOFT_BREAK]: "\n",
  // Ellipsis -> three dots, so "..." typed by an agent matches
  "…": "...",
};

/** Zero-width and bidi control characters, dropped entirely — they occupy an index but no glyph. */
const ZERO_WIDTH = new Set([
  "​",
  "‌",
  "‍",
  "﻿",
  "‎",
  "‏",
  "‪",
  "‫",
  "‬",
  "‭",
  "‮",
]);

export interface NormalizedText {
  /** The normalized string, suitable for matching. */
  text: string;
  /**
   * `map[i]` is the raw offset that normalized offset `i` came from. Length is `text.length + 1`;
   * the final entry is the raw length, so `map[end]` yields a correct exclusive end offset.
   */
  map: number[];
}

export interface NormalizeOptions {
  /** Fold case. Default true. */
  caseInsensitive?: boolean;
  /**
   * Collapse runs of whitespace to a single space and trim. Default true. Necessary because
   * agents rarely reproduce a document's exact internal spacing.
   */
  collapseWhitespace?: boolean;
}

/**
 * Normalize `raw` while retaining a mapping back to raw offsets.
 *
 * The map is what makes this safe to use for edits: match in normalized space, then translate
 * the match bounds through `map` to get a range that is exact in Google's index space.
 */
export function normalizeWithMap(raw: string, options: NormalizeOptions = {}): NormalizedText {
  const { caseInsensitive = true, collapseWhitespace = true } = options;

  const out: string[] = [];
  const map: number[] = [];
  /** Raw offset where the current run of whitespace began, or -1 when not in a run. */
  let whitespaceStart = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    if (ZERO_WIDTH.has(ch)) continue;

    const folded = CHAR_FOLDS[ch] ?? ch;

    if (collapseWhitespace && /\s/.test(folded)) {
      // Defer whitespace so a run collapses into at most one space, and so trailing
      // whitespace never makes it into the output at all.
      if (whitespaceStart === -1) whitespaceStart = i;
      continue;
    }

    if (whitespaceStart !== -1) {
      const runStart = whitespaceStart;
      whitespaceStart = -1;
      // Leading whitespace is dropped rather than emitted, which trims the string for free.
      if (out.length > 0) {
        out.push(" ");
        // The collapsed space must map to where the whitespace run *started*, not to the
        // character after it. Mapping forward makes an exclusive end offset that lands on this
        // space resolve past the whitespace, so a match ending just before a space silently
        // swallows it.
        map.push(runStart);
      }
    }

    // A fold may expand one raw char into several normalized chars (e.g. ellipsis -> "...").
    // Every resulting char maps back to the same raw offset, so a match covering any part of
    // the expansion still resolves to the whole original character.
    for (const outChar of folded) {
      out.push(caseInsensitive ? outChar.toLowerCase() : outChar);
      map.push(i);
    }
  }

  // Closing entry so an exclusive end offset at the very end of the string resolves correctly.
  map.push(raw.length);

  return { text: out.join(""), map };
}

/** Convenience wrapper when the offset map is not needed. */
export function normalize(raw: string, options?: NormalizeOptions): string {
  return normalizeWithMap(raw, options).text;
}

/**
 * Translate a match found in normalized space back to raw offsets.
 *
 * `normEnd` is exclusive. The returned `end` is also exclusive and is derived from `map[normEnd]`
 * rather than `map[normEnd - 1] + 1`, so multi-char folds are not truncated mid-expansion.
 */
export function toRawRange(
  norm: NormalizedText,
  normStart: number,
  normEnd: number,
): { start: number; end: number } {
  const start = norm.map[normStart];
  const end = norm.map[normEnd];
  if (start === undefined || end === undefined) {
    throw new Error(
      `Normalized offsets ${normStart}..${normEnd} fall outside the offset map (length ${norm.map.length})`,
    );
  }
  return { start, end };
}

/**
 * Strip the trailing paragraph mark from a block's text.
 *
 * Every Docs paragraph ends with a "\n" that is part of the paragraph itself and occupies an
 * index. Including it in a replacement range deletes the paragraph break and silently merges
 * two paragraphs — one of the most common ways naive Docs integrations mangle documents.
 */
export function stripParagraphMark(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
