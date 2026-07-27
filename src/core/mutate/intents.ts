import type { docs_v1 } from "googleapis";
import type { Block, DocRange } from "../ast/types.js";
import { at, toApiLocation, toApiRange, type PlannedRequest } from "./plan.js";

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
 * Insert a new paragraph after a block.
 *
 * The text is prefixed with a newline rather than suffixed, and inserted at the *end* of the
 * target block's text rather than at the start of the next one. Inserting at the next block's
 * start would place the text inside that block and make it inherit its styling — so a paragraph
 * added after a heading would itself become a heading.
 */
export function insertParagraphAfter(block: Block, text: string): PlannedRequest[] {
  const index = block.textRange.endIndex;
  return [
    at(index, {
      insertText: {
        location: toApiLocation(block.textRange, index),
        text: `\n${text}`,
      },
    }),
  ];
}

/** Insert a new paragraph before a block. */
export function insertParagraphBefore(block: Block, text: string): PlannedRequest[] {
  const index = block.range.startIndex;
  return [
    at(index, {
      insertText: {
        location: toApiLocation(block.range, index),
        text: `${text}\n`,
      },
    }),
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
