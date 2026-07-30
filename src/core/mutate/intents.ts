import type { docs_v1 } from "googleapis";
import type { Block, DocRange } from "../ast/types.js";
import { at, PHASE_STYLE, toApiLocation, toApiRange, type PlannedRequest } from "./plan.js";

/**
 * Semantic operations expressed as planned requests.
 *
 * Each function here answers one question: "what does the agent want, and which Docs requests
 * accomplish it without side effects it did not ask for?" The subtleties are mostly about what
 * *not* to touch — paragraph marks, list membership, styling inherited from neighbours.
 */

export interface TextFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Point size. */
  fontSize?: number;
  /** Hyperlink target; pass null-ish to clear. */
  link?: string;
  /** Font family, e.g. "Courier New" for code. */
  fontFamily?: string;
}

/**
 * Replace the text of a range, leaving the paragraph itself intact.
 *
 * Emitted as a delete followed by an insert at the same index. Both are anchored at the range's
 * start so the stable ordering keeps them adjacent and in that order: after the delete, the start
 * index is exactly where the new text belongs.
 *
 * The caller is responsible for passing a `textRange` rather than a `range`. Passing the latter
 * includes the paragraph mark, and deleting that merges this paragraph into the next one.
 */
export function replaceRange(range: DocRange, text: string): PlannedRequest[] {
  const requests: PlannedRequest[] = [];

  if (range.endIndex > range.startIndex) {
    requests.push(at(range.startIndex, { deleteContentRange: { range: toApiRange(range) } }));
  }

  if (text.length > 0) {
    requests.push(
      at(range.startIndex, {
        insertText: { location: toApiLocation(range), text },
      }),
    );
  }

  return requests;
}

/** Insert text at a point. */
export function insertAt(position: DocRange, text: string): PlannedRequest[] {
  if (text.length === 0) return [];
  return [at(position.startIndex, { insertText: { location: toApiLocation(position), text } })];
}

/**
 * Reset a freshly inserted paragraph to plain body text.
 *
 * **Paragraph style is always inherited, whichever side you insert on.** Inserting before the
 * target's paragraph mark puts the text inside that paragraph, and splitting it with a newline
 * leaves *both* halves carrying the original style — so a paragraph added after a heading becomes
 * a heading. Inserting after the mark instead puts the text at the head of the *following*
 * paragraph and inherits that one's style. There is no position that avoids it.
 *
 * So inheritance is undone explicitly rather than dodged. Bullets need their own request because
 * list membership is not part of `namedStyleType`, and is only cleared when the source block was
 * itself a list item — issuing it otherwise would be a no-op request on every single insert.
 */
function normalizeInsertedParagraph(
  range: DocRange,
  source: Block,
): PlannedRequest[] {
  const requests: PlannedRequest[] = [
    at(
      range.startIndex,
      {
        updateParagraphStyle: {
          range: toApiRange(range),
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
      PHASE_STYLE,
    ),
  ];

  if (source.kind === "listItem") {
    requests.push(
      at(range.startIndex, { deleteParagraphBullets: { range: toApiRange(range) } }, PHASE_STYLE),
    );
  }

  return requests;
}

/**
 * Insert a new paragraph after a block, as ordinary body text.
 *
 * The newline is written *before* the text so that the target block keeps its own paragraph mark
 * and the new content becomes a paragraph of its own.
 */
export interface InsertParagraphOptions {
  /**
   * Keep the neighbouring paragraph's formatting instead of resetting to body text.
   *
   * Inheritance is usually unwanted — it is what turns a paragraph added after a heading into
   * another heading. But it is exactly right when extending a run of similarly formatted
   * paragraphs: one more entry in a reference list with a hanging indent, one more line of an
   * address block. Resetting there would make the new entry the only one that looks wrong.
   */
  inheritStyle?: boolean;
}

export function insertParagraphAfter(
  block: Block,
  text: string,
  options: InsertParagraphOptions = {},
): PlannedRequest[] {
  const index = block.textRange.endIndex;
  // After the insert, the newline occupies `index` and the text runs from `index + 1`.
  const inserted: DocRange = {
    startIndex: index + 1,
    endIndex: index + 1 + text.length,
    segmentId: block.textRange.segmentId,
    tabId: block.textRange.tabId,
  };

  return [
    at(index, {
      insertText: { location: toApiLocation(block.textRange, index), text: `\n${text}` },
    }),
    ...(options.inheritStyle ? [] : normalizeInsertedParagraph(inserted, block)),
  ];
}

/** Insert a new paragraph before a block. */
export function insertParagraphBefore(
  block: Block,
  text: string,
  options: InsertParagraphOptions = {},
): PlannedRequest[] {
  const index = block.range.startIndex;
  const inserted: DocRange = {
    startIndex: index,
    endIndex: index + text.length,
    segmentId: block.range.segmentId,
    tabId: block.range.tabId,
  };

  return [
    at(index, {
      insertText: { location: toApiLocation(block.range, index), text: `${text}\n` },
    }),
    ...(options.inheritStyle ? [] : normalizeInsertedParagraph(inserted, block)),
  ];
}

/**
 * Delete a whole block, paragraph mark included.
 *
 * Uses `range` rather than `textRange` precisely because the paragraph should disappear rather
 * than be left behind as an empty line.
 */
export function deleteBlock(block: Block): PlannedRequest[] {
  const range = block.range;
  if (range.endIndex <= range.startIndex) return [];
  return [at(range.startIndex, { deleteContentRange: { range: toApiRange(range) } })];
}

/** Delete an arbitrary range. */
export function deleteRange(range: DocRange): PlannedRequest[] {
  if (range.endIndex <= range.startIndex) return [];
  return [at(range.startIndex, { deleteContentRange: { range: toApiRange(range) } })];
}

/**
 * Apply character formatting to a range.
 *
 * The `fields` mask lists exactly the properties being set. Anything absent from the mask is left
 * untouched — so making a phrase bold does not quietly reset its colour, size or link.
 */
export function formatRange(range: DocRange, format: TextFormat): PlannedRequest[] {
  if (range.endIndex <= range.startIndex) return [];

  const textStyle: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];

  if (format.bold !== undefined) {
    textStyle.bold = format.bold;
    fields.push("bold");
  }
  if (format.italic !== undefined) {
    textStyle.italic = format.italic;
    fields.push("italic");
  }
  if (format.underline !== undefined) {
    textStyle.underline = format.underline;
    fields.push("underline");
  }
  if (format.strikethrough !== undefined) {
    textStyle.strikethrough = format.strikethrough;
    fields.push("strikethrough");
  }
  if (format.fontSize !== undefined) {
    textStyle.fontSize = { magnitude: format.fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (format.link !== undefined) {
    textStyle.link = format.link ? { url: format.link } : {};
    fields.push("link");
  }
  if (format.fontFamily !== undefined) {
    // `weightedFontFamily` rather than a bare family name, because Docs stores weight alongside
    // the face; setting the family without a weight resets bold on the range.
    textStyle.weightedFontFamily = { fontFamily: format.fontFamily };
    fields.push("weightedFontFamily");
  }

  if (fields.length === 0) return [];

  return [
    at(range.startIndex, {
      updateTextStyle: { range: toApiRange(range), textStyle, fields: fields.join(",") },
    }),
  ];
}

/** Change a block's paragraph style, e.g. to promote a paragraph to a heading. */
export function setParagraphStyle(block: Block, namedStyleType: string): PlannedRequest[] {
  return [
    at(block.range.startIndex, {
      updateParagraphStyle: {
        range: toApiRange(block.range),
        paragraphStyle: { namedStyleType },
        fields: "namedStyleType",
      },
    }),
  ];
}

/** Turn blocks into list items. */
export function makeList(range: DocRange, ordered: boolean): PlannedRequest[] {
  return [
    at(range.startIndex, {
      createParagraphBullets: {
        range: toApiRange(range),
        bulletPreset: ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
      },
    }),
  ];
}

/**
 * Insert a table.
 *
 * Docs creates the table with empty cells; filling them requires a second cycle, because the cell
 * indices do not exist until the table does. `writeTable` in the tools layer does that pairing.
 */
export function insertTable(position: DocRange, rows: number, columns: number): PlannedRequest[] {
  return [
    at(position.startIndex, {
      insertTable: { location: toApiLocation(position), rows, columns },
    }),
  ];
}

/**
 * Insert an inline image from a URI.
 *
 * The URI must be reachable by Google's servers with no credentials, because Google fetches it
 * server-side. Images that live in Drive or on disk go through the asset pipeline, which hosts
 * them temporarily before calling this.
 */
export function insertImage(
  position: DocRange,
  uri: string,
  size?: { widthPt?: number; heightPt?: number },
): PlannedRequest[] {
  const objectSize: docs_v1.Schema$Size = {};
  if (size?.widthPt) objectSize.width = { magnitude: size.widthPt, unit: "PT" };
  if (size?.heightPt) objectSize.height = { magnitude: size.heightPt, unit: "PT" };

  return [
    at(position.startIndex, {
      insertInlineImage: {
        location: toApiLocation(position),
        uri,
        ...(objectSize.width || objectSize.height ? { objectSize } : {}),
      },
    }),
  ];
}

/** Create a named range so a region can be addressed later regardless of how it moves. */
export function createAnchor(name: string, range: DocRange): PlannedRequest[] {
  return [at(range.startIndex, { createNamedRange: { name, range: toApiRange(range) } })];
}
