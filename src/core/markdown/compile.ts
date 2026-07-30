import type { docs_v1 } from "googleapis";
import type { DocRange } from "../ast/types.js";
import type { InlineSpan, MdBlock } from "./parse.js";
import { at, PHASE_RESHAPE, PHASE_STYLE, toApiRange, type PlannedRequest } from "../mutate/plan.js";

/**
 * Structured Markdown blocks → Docs requests.
 *
 * The whole fragment is inserted as **one** `insertText`, and everything else styles ranges of
 * that inserted text. This is not merely an optimization: an insert per block would make every
 * block's position depend on the exact index shift caused by the blocks before it, which is the
 * arithmetic this project refuses to do. One insert means every offset is known in advance,
 * measured against a string held in memory.
 *
 * Ordering is expressed through phases rather than index, because the dependencies here are
 * causal rather than positional — see `PHASE_STYLE` and `PHASE_RESHAPE`.
 */

/** Font used to render inline code and code blocks. */
const CODE_FONT = "Courier New";

export interface CompiledMarkdown {
  requests: PlannedRequest[];
  /** The plain text that will be inserted, for reporting and for tests. */
  text: string;
  /**
   * Tables found in the Markdown, which cannot be built in the same batch.
   *
   * A table's cells do not exist — and therefore have no indices — until the table itself has
   * been created, so filling them requires a second cycle against a re-read document. The
   * compiler surfaces them rather than silently dropping them.
   */
  pendingTables: PendingTable[];
}

export interface PendingTable {
  /** Offset within `text` after which this table belongs. */
  afterOffset: number;
  /**
   * Text of the block this table follows, or undefined when the table leads the fragment.
   *
   * The table is placed in a later cycle, against a document that has been re-read, so a
   * remembered index would be worthless. The preceding block's text is an address that survives
   * the round trip — the same content-addressing principle the rest of the system runs on.
   */
  afterBlockText: string | undefined;
  rows: { text: string; spans: InlineSpan[] }[][];
}

/** Build a `Schema$TextStyle` and its field mask from an inline style. */
function inlineStyle(span: InlineSpan): { style: docs_v1.Schema$TextStyle; fields: string[] } {
  const style: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];

  if (span.style.bold) {
    style.bold = true;
    fields.push("bold");
  }
  if (span.style.italic) {
    style.italic = true;
    fields.push("italic");
  }
  if (span.style.strikethrough) {
    style.strikethrough = true;
    fields.push("strikethrough");
  }
  if (span.style.code) {
    style.weightedFontFamily = { fontFamily: CODE_FONT };
    fields.push("weightedFontFamily");
  }
  if (span.style.link) {
    style.link = { url: span.style.link };
    fields.push("link");
  }

  return { style, fields };
}

/** Named style for a heading level. */
function headingStyle(level: number): string {
  const clamped = Math.min(6, Math.max(1, level));
  return `HEADING_${clamped}`;
}

/**
 * Compile Markdown blocks into requests that insert them at `position`.
 *
 * `position` must be a zero-width location. The caller is responsible for having resolved it
 * against a document read moments earlier.
 */
export function compileMarkdown(blocks: MdBlock[], position: DocRange): CompiledMarkdown {
  const base = position.startIndex;
  const segment = { segmentId: position.segmentId, tabId: position.tabId };

  /** Assembled plain text, and where each block landed inside it. */
  const parts: string[] = [];
  let offset = 0;

  interface Placed {
    block: MdBlock;
    /** Offset of the block's text within the assembled string. */
    start: number;
    /** Offset just past the block's text, excluding its paragraph break. */
    end: number;
  }
  const placed: Placed[] = [];
  const pendingTables: PendingTable[] = [];

  for (const block of blocks) {
    if (block.kind === "table") {
      // Recorded against the current offset so the tool layer knows where it belongs, then
      // skipped — tables are built in a later cycle.
      pendingTables.push({
        afterOffset: offset,
        afterBlockText: placed[placed.length - 1]?.block.text,
        rows: block.rows ?? [],
      });
      continue;
    }

    // Nesting depth is encoded as leading tabs, which is how `createParagraphBullets` reads it.
    // Those tabs are part of the inserted text and shift the block's own span offsets, so they
    // are added before recording where the text starts.
    const indent = block.kind === "listItem" ? "\t".repeat(block.depth ?? 0) : "";
    if (indent) {
      parts.push(indent);
      offset += indent.length;
    }

    const start = offset;
    parts.push(block.text);
    offset += block.text.length;
    const end = offset;

    placed.push({ block, start, end });

    // Every block is terminated by a paragraph break; the caller trims the final one if it is
    // appending rather than inserting into the middle.
    parts.push("\n");
    offset += 1;
  }

  const text = parts.join("");
  const requests: PlannedRequest[] = [];

  if (text.length === 0) return { requests, text, pendingTables };

  requests.push(
    at(base, {
      insertText: { location: { index: base, ...segment }, text },
    }),
  );

  const rangeOf = (start: number, end: number): DocRange => ({
    startIndex: base + start,
    endIndex: base + end,
    ...segment,
  });

  for (const item of placed) {
    const { block, start, end } = item;

    // Inline spans, rebased from block-relative to document-absolute.
    for (const span of block.spans) {
      const { style, fields } = inlineStyle(span);
      if (fields.length === 0) continue;
      const from = start + span.start;
      const to = start + span.end;
      if (to <= from) continue;
      requests.push(
        at(
          base + from,
          {
            updateTextStyle: {
              range: toApiRange(rangeOf(from, to)),
              textStyle: style,
              fields: fields.join(","),
            },
          },
          PHASE_STYLE,
        ),
      );
    }

    // A paragraph style needs a non-empty range to land on. An empty heading has nothing to
    // style, and sending a zero-width range is rejected.
    const styleRange = rangeOf(start, Math.max(start + 1, end));

    if (block.kind === "heading") {
      requests.push(
        at(
          base + start,
          {
            updateParagraphStyle: {
              range: toApiRange(styleRange),
              paragraphStyle: { namedStyleType: headingStyle(block.level ?? 1) },
              fields: "namedStyleType",
            },
          },
          PHASE_STYLE,
        ),
      );
      continue;
    }

    if (block.kind === "code") {
      requests.push(
        at(
          base + start,
          {
            updateTextStyle: {
              range: toApiRange(styleRange),
              textStyle: { weightedFontFamily: { fontFamily: CODE_FONT } },
              fields: "weightedFontFamily",
            },
          },
          PHASE_STYLE,
        ),
      );
      continue;
    }

    if (block.kind === "rule") {
      // Docs has no horizontal-rule element. A paragraph carrying only a bottom border is what
      // the editor itself produces for one, so it round-trips visually.
      requests.push(
        at(
          base + start,
          {
            updateParagraphStyle: {
              range: toApiRange(styleRange),
              paragraphStyle: {
                borderBottom: {
                  color: { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } },
                  width: { magnitude: 1, unit: "PT" },
                  padding: { magnitude: 1, unit: "PT" },
                  dashStyle: "SOLID",
                },
              },
              fields: "borderBottom",
            },
          },
          PHASE_STYLE,
        ),
      );
      continue;
    }

    if (block.quote) {
      // Indentation alone is not enough: an indented paragraph following a list renders as a
      // continuation of the last list item, both in the editor and in Google's own Markdown
      // export. The left border is what makes it unambiguously a quote.
      requests.push(
        at(
          base + start,
          {
            updateParagraphStyle: {
              range: toApiRange(styleRange),
              paragraphStyle: {
                indentStart: { magnitude: 36, unit: "PT" },
                borderLeft: {
                  color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
                  width: { magnitude: 3, unit: "PT" },
                  padding: { magnitude: 8, unit: "PT" },
                  dashStyle: "SOLID",
                },
              },
              fields: "indentStart,borderLeft",
            },
          },
          PHASE_STYLE,
        ),
      );
    }
  }

  // Consecutive list items of the same kind become one bullets request. Grouping matters beyond
  // tidiness: a single request over a contiguous range is what lets Docs number an ordered list
  // continuously instead of restarting at each item.
  let runStart: Placed | undefined;
  let runEnd: Placed | undefined;
  let runOrdered = false;

  const flushRun = () => {
    if (!runStart || !runEnd) return;
    const range = rangeOf(runStart.start, runEnd.end);
    requests.push(
      at(
        range.startIndex,
        {
          createParagraphBullets: {
            range: toApiRange(range),
            bulletPreset: runOrdered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
          },
        },
        PHASE_RESHAPE,
      ),
    );
    runStart = undefined;
    runEnd = undefined;
  };

  for (const item of placed) {
    if (item.block.kind !== "listItem") {
      flushRun();
      continue;
    }
    const ordered = Boolean(item.block.ordered);
    if (runStart && ordered !== runOrdered) flushRun();
    if (!runStart) {
      runStart = item;
      runOrdered = ordered;
    }
    runEnd = item;
  }
  flushRun();

  return { requests, text, pendingTables };
}
