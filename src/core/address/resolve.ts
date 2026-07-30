import type { Block, DocRange, ParsedDocument } from "../ast/types.js";
import { normalizeWithMap, toRawRange } from "../ast/text.js";

/**
 * Turning what an agent said into where it meant.
 *
 * The guiding rule is that **an ambiguous address is an error, never a guess.** If "replace the
 * paragraph about deadlines" matches three paragraphs, silently picking the first one produces a
 * confidently wrong edit that nobody notices until much later. Returning the three candidates
 * costs one extra round trip and makes the mistake impossible.
 */

export type Address =
  /** A content-derived handle from a previous read. */
  | { kind: "block"; id: string }
  /** Literal or approximate text. Matches whole blocks or spans inside them. */
  | { kind: "text"; query: string; occurrence?: number; fuzzy?: boolean }
  /** A heading, by its text and optionally its level. */
  | { kind: "heading"; text: string; level?: number }
  /** A named range previously placed in the document. */
  | { kind: "anchor"; name: string }
  /** The very start or end of a tab's body. */
  | { kind: "position"; at: "start" | "end"; tabId?: string };

export type ResolutionMethod = "block-id" | "exact" | "fuzzy" | "anchor" | "position" | "heading";

export interface Resolution {
  /** The block the address landed in. Absent for whole-document positions. */
  block: Block | undefined;
  /** The range to operate on. */
  range: DocRange;
  method: ResolutionMethod;
  /** 1 for exact matches; the similarity score for fuzzy ones. */
  confidence: number;
}

export interface Candidate {
  id: string;
  text: string;
  score: number;
}

export class AddressError extends Error {
  readonly candidates: Candidate[];

  constructor(message: string, candidates: Candidate[] = []) {
    const detail =
      candidates.length > 0
        ? `\n\nClosest matches:\n${candidates
            .map((c) => `  {#${c.id}}  "${truncate(c.text, 70)}"${c.score < 1 ? `  (${Math.round(c.score * 100)}% similar)` : ""}`)
            .join("\n")}`
        : "";
    super(message + detail);
    this.name = "AddressError";
    this.candidates = candidates;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/* Similarity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Dice coefficient over character bigrams.
 *
 * Chosen over edit distance because it is linear rather than quadratic — fuzzy resolution scores
 * the query against every block in the document, and a 200-page document has thousands of them.
 * It is also naturally robust to reordered words and to a paraphrase that keeps most of the
 * wording, which is exactly how an agent misremembers a sentence.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      shared++;
    }
  }

  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Minimum similarity for a fuzzy match to be considered at all. */
const FUZZY_THRESHOLD = 0.7;
/** How far ahead the best fuzzy match must be before it is treated as unambiguous. */
const FUZZY_MARGIN = 0.08;

/* -------------------------------------------------------------------------- */
/* Text search                                                                 */
/* -------------------------------------------------------------------------- */

export interface TextMatch {
  block: Block;
  /** Exact document range of the matched span. */
  range: DocRange;
  /** The text as actually stored in the document, which may differ from the query. */
  matched: string;
}

/**
 * Find every occurrence of `query` as a span inside the document's blocks.
 *
 * Matching happens in normalized space — so a query typed with straight quotes finds text Docs
 * curled — and the resulting offsets are translated back through the offset map, giving a range
 * that addresses the original characters exactly.
 */
export function findTextMatches(document: ParsedDocument, query: string): TextMatch[] {
  const needle = normalizeWithMap(query).text;
  if (needle.length === 0) return [];

  const matches: TextMatch[] = [];

  for (const block of document.blocks) {
    if (block.text.length === 0) continue;
    const haystack = normalizeWithMap(block.text);

    let from = 0;
    for (;;) {
      const at = haystack.text.indexOf(needle, from);
      if (at === -1) break;

      const raw = toRawRange(haystack, at, at + needle.length);
      matches.push({
        block,
        range: {
          // Block-local offsets are document indices plus the block's start, because the walk
          // guarantees one character of block text per document index.
          startIndex: block.textRange.startIndex + raw.start,
          endIndex: block.textRange.startIndex + raw.end,
          segmentId: block.textRange.segmentId,
          tabId: block.textRange.tabId,
        },
        matched: block.text.slice(raw.start, raw.end),
      });

      from = at + Math.max(1, needle.length);
    }
  }

  return matches;
}

/* -------------------------------------------------------------------------- */
/* Address resolution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Body blocks of one tab that can actually anchor an insertion, in document order.
 *
 * Structural markers are excluded. Every Docs body opens with a `sectionBreak` occupying index 0,
 * and index 0 is not addressable — inserting there is rejected outright with "the insertion index
 * must be inside the bounds of an existing paragraph". Treating it as the first block makes every
 * insert-at-start fail.
 */
function bodyBlocks(document: ParsedDocument, tabId: string | undefined): Block[] {
  const targetTab = tabId ?? document.tabs[0]?.tabId ?? "";
  return document.blocks.filter(
    (b) =>
      b.range.tabId === targetTab &&
      b.range.segmentId === "" &&
      b.kind !== "sectionBreak" &&
      b.range.startIndex >= 1,
  );
}

/**
 * The end of a tab's body, together with the block that sits there.
 *
 * The block matters as much as the position: inserting a paragraph inherits the surrounding
 * paragraph's style, so callers need the neighbour in order to undo that inheritance. Returning
 * only a bare index is what let an inserted paragraph silently become a heading.
 */
function endOfBody(
  document: ParsedDocument,
  tabId: string | undefined,
): { range: DocRange; block: Block | undefined } {
  const targetTab = tabId ?? document.tabs[0]?.tabId ?? "";
  const blocks = bodyBlocks(document, tabId);
  const last = blocks[blocks.length - 1];
  // Docs reserves index 0; a document's body always begins at 1.
  const index = last ? last.range.endIndex - 1 : 1;
  return {
    range: { startIndex: index, endIndex: index, segmentId: "", tabId: targetTab },
    block: last,
  };
}

function startOfBody(
  document: ParsedDocument,
  tabId: string | undefined,
): { range: DocRange; block: Block | undefined } {
  const targetTab = tabId ?? document.tabs[0]?.tabId ?? "";
  return {
    range: { startIndex: 1, endIndex: 1, segmentId: "", tabId: targetTab },
    block: bodyBlocks(document, tabId)[0],
  };
}

/** Resolve an address against a freshly-read document. */
export function resolveAddress(document: ParsedDocument, address: Address): Resolution {
  switch (address.kind) {
    case "position": {
      const edge =
        address.at === "start"
          ? startOfBody(document, address.tabId)
          : endOfBody(document, address.tabId);
      return { block: edge.block, range: edge.range, method: "position", confidence: 1 };
    }

    case "anchor": {
      const ranges = document.namedRanges[address.name];
      if (!ranges?.length) {
        const known = Object.keys(document.namedRanges);
        throw new AddressError(
          `No anchor named "${address.name}" in this document.` +
            (known.length ? ` Known anchors: ${known.join(", ")}.` : " This document has no anchors."),
        );
      }
      // An edit can split a named range into several; the first covers the anchor's start.
      const range = ranges[0]!;
      const block = document.blocks.find(
        (b) => b.range.tabId === range.tabId && b.range.startIndex <= range.startIndex && b.range.endIndex >= range.endIndex,
      );
      return { block, range, method: "anchor", confidence: 1 };
    }

    case "block": {
      const block = document.blocks.find((b) => b.id === address.id);
      if (block) {
        return { block, range: block.textRange, method: "block-id", confidence: 1 };
      }
      // A stale id is expected rather than exceptional: the block may have been edited, which
      // changes its hash. Offering the nearest surviving blocks turns a dead end into a retry.
      throw new AddressError(
        `No block with id "${address.id}" in the current document. It was probably edited, ` +
          `which changes its content-derived id. Read the document again to get current ids.`,
      );
    }

    case "heading": {
      const wanted = normalizeWithMap(address.text).text;
      const headings = document.blocks.filter(
        (b) => b.kind === "heading" && (address.level === undefined || b.level === address.level),
      );

      const exact = headings.filter((h) => normalizeWithMap(h.text).text === wanted);
      if (exact.length === 1) {
        return { block: exact[0]!, range: exact[0]!.textRange, method: "heading", confidence: 1 };
      }
      if (exact.length > 1) {
        throw new AddressError(
          `"${address.text}" matches ${exact.length} headings. Use a block id to disambiguate.`,
          exact.map((h) => ({ id: h.id, text: h.text, score: 1 })),
        );
      }

      const scored = headings
        .map((h) => ({ block: h, score: similarity(normalizeWithMap(h.text).text, wanted) }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best || best.score < FUZZY_THRESHOLD) {
        throw new AddressError(
          `No heading matching "${address.text}".`,
          scored.slice(0, 5).map((s) => ({ id: s.block.id, text: s.block.text, score: s.score })),
        );
      }
      return { block: best.block, range: best.block.textRange, method: "fuzzy", confidence: best.score };
    }

    case "text":
      return resolveText(document, address);
  }
}

function resolveText(
  document: ParsedDocument,
  address: Extract<Address, { kind: "text" }>,
): Resolution {
  const matches = findTextMatches(document, address.query);

  if (matches.length > 0) {
    if (address.occurrence !== undefined) {
      const chosen = matches[address.occurrence - 1];
      if (!chosen) {
        throw new AddressError(
          `Asked for occurrence ${address.occurrence} of "${truncate(address.query, 50)}", ` +
            `but there ${matches.length === 1 ? "is" : "are"} only ${matches.length}.`,
        );
      }
      return { block: chosen.block, range: chosen.range, method: "exact", confidence: 1 };
    }

    if (matches.length === 1) {
      const only = matches[0]!;
      return { block: only.block, range: only.range, method: "exact", confidence: 1 };
    }

    throw new AddressError(
      `"${truncate(address.query, 50)}" appears ${matches.length} times. ` +
        `Pass an occurrence number, or address the block directly by its id.`,
      matches.slice(0, 8).map((m) => ({ id: m.block.id, text: m.block.text, score: 1 })),
    );
  }

  if (address.fuzzy === false) {
    throw new AddressError(`No exact match for "${truncate(address.query, 50)}".`);
  }

  // Nothing matched literally, so fall back to whole-block similarity. This is where an agent
  // that paraphrased, or that quoted text a collaborator has since reworded, still lands.
  const wanted = normalizeWithMap(address.query).text;
  const scored = document.blocks
    .filter((b) => b.text.length > 0)
    .map((b) => ({ block: b, score: similarity(normalizeWithMap(b.text).text, wanted) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < FUZZY_THRESHOLD) {
    throw new AddressError(
      `Nothing in this document matches "${truncate(address.query, 50)}".`,
      scored.slice(0, 5).map((s) => ({ id: s.block.id, text: s.block.text, score: s.score })),
    );
  }

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < FUZZY_MARGIN) {
    throw new AddressError(
      `"${truncate(address.query, 50)}" is similarly close to several blocks; ` +
        `too ambiguous to edit safely. Address one directly by its id.`,
      scored.slice(0, 5).map((s) => ({ id: s.block.id, text: s.block.text, score: s.score })),
    );
  }

  return {
    block: best.block,
    range: best.block.textRange,
    method: "fuzzy",
    confidence: best.score,
  };
}
